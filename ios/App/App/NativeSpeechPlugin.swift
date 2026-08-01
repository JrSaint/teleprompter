import Foundation
import Capacitor
import Speech
import AVFoundation
import UIKit

/**
 * On-device speech for the voice prompter.
 *
 * Engine selection at runtime:
 *  - iPadOS 26+ on capable hardware: SpeechAnalyzer/SpeechTranscriber
 *    (word-level audio time ranges) — see NativeSpeechAnalyzer.swift.
 *    Unsupported hardware skips it cleanly with one env note.
 *  - Otherwise/fallback: SFSpeechRecognizer with
 *    requiresOnDeviceRecognition and contextualStrings vocabulary.
 *
 * B.2 silence sprint:
 *  - start/stop serialized through a state queue — a duplicate start is
 *    a labeled no-op event, provably not a second engine
 *  - AVAudioSession uses .playAndRecord/.default (a bare .record with
 *    .measurement can yield zero-filled buffers alongside the WKWebView
 *    audio session — the recorded flatline)
 *  - env reports record permission, session category/mode/sample rate,
 *    input availability, and a resolvedSupported flag with FULL locale
 *    lists — the target locale's status is never hidden by truncation
 */
@objc(NativeSpeechPlugin)
public class NativeSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSpeechPlugin"
    public let jsName = "NativeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prewarm", returnType: CAPPluginReturnPromise),
    ]

    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var localeId = "en-US"
    private var vocabulary: [String] = []
    /** Server-assisted recognition (ship-gate fallback, pt-BR only —
        JS gates it): flips requiresOnDeviceRecognition off. Default
        false; EN never sets it. */
    private var allowServer = false
    private var sessionStartEpochMs: Double = 0
    private var endedAtEpochMs: Double = 0
    private var analyzerBox: AnyObject?

    // restart discipline: a session that dies without producing words
    // counts as a failure; respawns back off exponentially and stop
    // for good after MAX_CONSECUTIVE_FAILURES — never a hot loop
    private var consecutiveFailures = 0
    private var wordsThisSession = false
    private static let maxConsecutiveFailures = 5

    // start/stop serialization — the only writers of `active`
    private let stateQueue = DispatchQueue(label: "nativespeech.state")
    private var active = false
    private var startSeq = 0

    // tap-confirmed listening + level metering (audio-thread touched,
    // lock-guarded)
    private let meterLock = NSLock()
    private var pendingListeningDetail: String?
    private var lastLevelEmitMs: Double = 0

    // Anchor at actual audio flow: segment timestamps are relative to
    // the audio the request has consumed, so the wallclock anchor must
    // be the FIRST buffer appended to each request — not task spawn.
    private var anchorPending = false

    // Voice-activity onset detection (buffer resolution, ~21ms): after
    // ≥600ms of quiet, the first sustained voiced buffers emit ONE
    // "voice-onset" with the wallclock. The JS side correlates it with
    // the next token arrival — the emission-lag fallback when the
    // engine zeroes segment timings (observed on-device: every partial
    // in the B.3 tapes carried no usable timestamp).
    private static let vadVoiceRms: Float = 0.008
    private static let vadQuietMinMs: Double = 600
    private var vadQuietSinceMs: Double = 0
    private var vadVoicedStreak = 0
    private var vadArmed = false

    // Token-silence watchdog (B.3.3 finding 3b): the PT tape shows the
    // recognizer emitting isolated words 8.6s apart through continuous
    // speech. If ≥5s of VOICED audio accumulates with zero results
    // from the task, the task is dead weight — restart it (the JS side
    // reuses restart-grace). Guarded by the meter lock; a generation
    // counter keeps a cancelled task's completion from double-spawning.
    private static let watchdogVoicedMaxMs: Double = 5000
    private var watchdogVoicedMs: Double = 0
    private var watchdogPending = false

    // Proactive task-age rotation (engine surgery items 2/3/5): a
    // recognition task is retired BEFORE it ages into transcript
    // regurgitation (B.4 recurrence: an 81-token re-emission ~35s
    // into the task, below the watchdog's radar — the watchdog never
    // fired on that whole tape). The new task overlaps the old, the
    // tap feeds BOTH requests during the overlap (zero word loss),
    // and the old task's results stay accepted until a short deadline
    // so its final flush isn't dropped. Server-assisted sessions
    // rotate earlier (Apple's ~60s server task limit).
    private static let rotationOverlapMs: Double = 1000
    private static let retireDeadlineMs: Double = 2500
    private var rotationAgeMs: Double { allowServer ? 40_000 : 45_000 }
    private var retiringRequest: SFSpeechAudioBufferRecognitionRequest?
    private var retiringTask: SFSpeechRecognitionTask?
    private var retiringGeneration = 0     // 0 = none (generations start at 1)
    private var retiringUntilMs: Double = 0
    private var rotationTimer: DispatchWorkItem?
    private var prewarmedRecognizer: SFSpeechRecognizer?
    /** Wallclock anchor of each request's audio t=0, by generation —
        a retiring task's final flush must ship ITS OWN anchor, not
        the fresh task's (else timestamps land a rotation-age in the
        future). meterLock-guarded. */
    private var anchorByGen: [Int: Double] = [:]
    private var taskGeneration = 0
    private var currentRecognizer: SFSpeechRecognizer?

    @objc func start(_ call: CAPPluginCall) {
        let (isDuplicate, seq): (Bool, Int) = stateQueue.sync {
            if active { return (true, startSeq) }
            active = true
            startSeq += 1
            return (false, startSeq)
        }
        if isDuplicate {
            emitStatus("starting", detail: "duplicate-start-ignored (seq \(seq))")
            call.resolve()
            return
        }
        localeId = call.getString("locale") ?? "en-US"
        vocabulary = call.getArray("vocabulary", String.self) ?? []
        allowServer = call.getBool("allowServer") ?? false
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            guard let self = self else { return }
            guard auth == .authorized else {
                self.setInactive()
                self.emitStatus("denied", detail: "speech recognition not authorized")
                call.resolve()
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    self.setInactive()
                    self.emitStatus("denied", detail: "Microphone access is off for Voice Prompter. Enable it in Settings → Privacy → Microphone.")
                    call.resolve()
                    return
                }
                DispatchQueue.main.async {
                    self.begin(seq: seq)
                    call.resolve()
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopAll()
        call.resolve()
    }

    /// Pre-warm at app launch (engine surgery item 4): front-load the
    /// audio-session configuration and the recognizer/daemon spin-up
    /// so the first arm reaches listening fast (history: 3.7–4.8s
    /// cold starts). NO permission prompts here — auth stays at the
    /// first arm; without it only the cheap parts warm.
    @objc func prewarm(_ call: CAPPluginCall) {
        let locale = call.getString("locale") ?? "en-US"
        DispatchQueue.main.async {
            // never reconfigure the audio session under a LIVE engine —
            // a category change mid-capture can stop the tap silently
            guard !self.isActive else {
                call.resolve(["detail": "skipped: session active"])
                return
            }
            _ = try? self.configureAudioSession()
            let rec = SFSpeechRecognizer(locale: Locale(identifier: locale))
            self.prewarmedRecognizer = rec
            var warmed = "session"
            if SFSpeechRecognizer.authorizationStatus() == .authorized,
               let rec = rec, rec.isAvailable, rec.supportsOnDeviceRecognition {
                // a zero-audio dummy task spins up the daemon + model;
                // it errors out harmlessly (no audio) and is cancelled
                let req = SFSpeechAudioBufferRecognitionRequest()
                req.requiresOnDeviceRecognition = true
                req.shouldReportPartialResults = false
                let t = rec.recognitionTask(with: req) { _, _ in }
                req.endAudio()
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { t.cancel() }
                warmed = "session+recognizer+model"
            }
            self.emitStatus("prewarmed", detail: "\(locale) \(warmed)")
            call.resolve(["detail": "\(locale) \(warmed)"])
        }
    }

    private func setInactive() {
        stateQueue.sync { active = false }
    }

    var isActive: Bool { stateQueue.sync { active } }

    private func begin(seq: Int) {
        emitStatus("starting", detail: "plugin (seq \(seq))")
        if #available(iOS 26.0, *) {
            Task { @MainActor in
                let analyzer = NativeSpeechAnalyzer(plugin: self, localeId: self.localeId)
                self.analyzerBox = analyzer
                do {
                    try await analyzer.start()
                } catch is AnalyzerUnsupported {
                    // clean skip — one env note, no error spam
                    guard self.isActive else { return }
                    self.analyzerBox = nil
                    self.startRecognizer()
                } catch {
                    guard self.isActive else { return }
                    self.analyzerBox = nil
                    self.emitStatus("error", detail: "analyzer: \(error.localizedDescription)")
                    self.startRecognizer()
                }
            }
        } else {
            startRecognizer()
        }
    }

    // MARK: - shared audio session (record-capable + WebView-friendly)

    func configureAudioSession() throws -> AVAudioSession {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default,
                                options: [.defaultToSpeaker, .allowBluetooth, .duckOthers])
        // Pin the rate: the B.3.3 PT session drifted to 44100Hz while
        // EN ran at 48000Hz minutes apart (finding 3a). Preferred
        // values are requests — the granted values are logged in env.
        try? session.setPreferredSampleRate(48000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        return session
    }

    /// On-device recognition support for both app locales — answers
    /// "which engine for PT" from any session's env, without a PT run.
    func onDeviceProbe() -> [String: Bool] {
        var probe: [String: Bool] = [:]
        for id in ["en-US", "pt-BR"] {
            probe[id] = SFSpeechRecognizer(locale: Locale(identifier: id))?
                .supportsOnDeviceRecognition ?? false
        }
        return probe
    }

    func sessionEnvFields() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let permission: String
        switch session.recordPermission {
        case .granted: permission = "granted"
        case .denied: permission = "denied"
        case .undetermined: permission = "undetermined"
        @unknown default: permission = "unknown"
        }
        let inputs = session.currentRoute.inputs
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ", ")
        return [
            "recordPermission": permission,
            "serverAssisted": allowServer,
            "sessionCategory": session.category.rawValue,
            "sessionMode": session.mode.rawValue,
            "sessionSampleRate": session.sampleRate,
            "preferredSampleRate": session.preferredSampleRate,
            "inputRoute": inputs,
            "isInputAvailable": session.isInputAvailable,
        ]
    }

    // MARK: - SFSpeechRecognizer path (on-device required)

    private func startRecognizer() {
        guard isActive else { return } // stopped before start finished
        let prewarmed = prewarmedRecognizer?.locale.identifier == Locale(identifier: localeId).identifier
            ? prewarmedRecognizer : nil
        guard let recognizer = prewarmed ?? SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            emitStatus("unavailable", detail: "no recognizer exists for \(localeId)")
            return
        }
        guard recognizer.isAvailable else {
            emitStatus("unavailable", detail: "recognizer for \(localeId) is not available right now")
            return
        }
        do {
            _ = try configureAudioSession()
        } catch {
            emitStatus("error", detail: "audio session failed: \(error.localizedDescription)")
            return
        }
        let supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted()
        let resolvedSupported = supported.contains(recognizer.locale.identifier)
        var env: [String: Any] = [
            "engine": "recognizer",
            "locale": recognizer.locale.identifier,
            "resolvedSupported": resolvedSupported,
            "onDevice": recognizer.supportsOnDeviceRecognition,
            "onDeviceByLocale": onDeviceProbe(),
            "supported": supported,
            "installed": [],
        ]
        env.merge(sessionEnvFields()) { a, _ in a }
        emitEnv(env)
        // On-device policy: check BEFORE forcing it; never silently
        // listen to nothing, never fall back to server-side on our own.
        // The ONLY exception is an explicit allowServer start option
        // (pt-BR ship-gate fallback) — the caller has shown the
        // per-language privacy copy before asking for it.
        guard recognizer.supportsOnDeviceRecognition || allowServer else {
            emitStatus("unavailable",
                       detail: "This iPad cannot run \(localeId) speech recognition on-device. The native engine never sends audio to servers, so it cannot continue. Use the Web engine for this script.")
            return
        }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitStatus("error", detail: "microphone reports an invalid audio format (\(format.sampleRate) Hz)")
            return
        }
        currentRecognizer = recognizer
        // readiness gate: the armed UI shows "warming" until the tap
        // delivers the FIRST real buffer ('listening' is emitted from
        // the tap-confirmed path, never assumed)
        emitStatus("warming", detail: "audio engine + recognizer spin-up")
        armListeningConfirmation(detail: "recognizer")
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.onTapBuffer(buffer)
            if self.request != nil {
                self.meterLock.lock()
                if self.anchorPending {
                    self.anchorPending = false
                    self.sessionStartEpochMs = Date().timeIntervalSince1970 * 1000
                    self.anchorByGen[self.taskGeneration] = self.sessionStartEpochMs
                }
                self.meterLock.unlock()
            }
            self.request?.append(buffer)
            self.retiringRequest?.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emitStatus("error", detail: "audio engine failed: \(error.localizedDescription)")
            return
        }
        spawnRecognitionTask(recognizer)
    }

    private func spawnRecognitionTask(_ recognizer: SFSpeechRecognizer) {
        guard isActive else { return } // a stop won the race
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = !allowServer
        // B.3 engine levers: prompting is dictation-shaped, and
        // punctuation insertion only adds latency and re-statements
        req.taskHint = .dictation
        if #available(iOS 16.0, *) { req.addsPunctuation = false }
        if !vocabulary.isEmpty { req.contextualStrings = vocabulary }
        // Arm the anchor BEFORE publishing the request: the tap starts
        // appending the moment `request` is non-nil, and the anchor
        // must stamp that first appended buffer (the request's audio
        // t=0), not a later one. Provisional value covers the gap.
        // A fresh task also resets the watchdog and advances the
        // generation, orphaning any cancelled task's completion.
        meterLock.lock()
        sessionStartEpochMs = Date().timeIntervalSince1970 * 1000
        anchorPending = true
        watchdogVoicedMs = 0
        watchdogPending = false
        taskGeneration += 1
        let gen = taskGeneration
        meterLock.unlock()
        request = req
        wordsThisSession = false

        if endedAtEpochMs > 0 {
            let gap = Date().timeIntervalSince1970 * 1000 - endedAtEpochMs
            emitStatus("restart-gap", detail: String(Int(gap)))
            endedAtEpochMs = 0
        }

        // proactive rotation: retire this task before regurgitation age
        rotationTimer?.cancel()
        let rot = DispatchWorkItem { [weak self] in
            guard let self = self, self.isActive,
                  gen == self.liveGeneration() else { return }
            self.rotateTask(reason: "task-age \(Int(self.rotationAgeMs))ms")
        }
        rotationTimer = rot
        DispatchQueue.main.asyncAfter(deadline: .now() + rotationAgeMs / 1000.0, execute: rot)

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, self.isActive else { return }
            let live = gen == self.liveGeneration()
            // a retiring task's results stay accepted until its
            // deadline — its final flush must not be dropped
            guard live || self.isRetiringGen(gen) else { return }
            if let result = result {
                var words: [String] = []
                var ends: [Double] = []
                for seg in result.bestTranscription.segments {
                    // NOTE: partial results may report 0 timestamps until
                    // finalization — the JS side skips the speech-to-swap
                    // metric for zero audio times.
                    let end = (seg.timestamp + seg.duration) * 1000
                    // a segment's substring can carry several words
                    // ("test read") — one entry per word, same end time
                    for piece in seg.substring.split(whereSeparator: { $0.isWhitespace }) {
                        words.append(String(piece))
                        ends.append(end)
                    }
                }
                if !words.isEmpty && live {
                    self.wordsThisSession = true
                    self.consecutiveFailures = 0
                    // results are flowing — the watchdog stands down
                    self.meterLock.lock()
                    self.watchdogVoicedMs = 0
                    self.meterLock.unlock()
                }
                self.emitWords(words, ends: ends, isFinal: result.isFinal, engine: "recognizer", gen: gen)
            }
            if let error = error, live {
                self.emitStatus("error", detail: "recognition task: \(error.localizedDescription)")
            }
            if error != nil || (result?.isFinal ?? false) {
                if !live {
                    // a retiring task ended (final flush or cancel) —
                    // clean up; never counts as a failure
                    DispatchQueue.main.async { self.clearRetiring(gen: gen) }
                    return
                }
                // A session that produced no words and died is a failure:
                // back off exponentially and give up after a few — a hot
                // restart loop is silence pretending to work.
                if error != nil && !self.wordsThisSession {
                    self.consecutiveFailures += 1
                } else {
                    self.consecutiveFailures = 0
                }
                if self.consecutiveFailures >= Self.maxConsecutiveFailures {
                    let last = error?.localizedDescription ?? "unknown error"
                    self.emitStatus("unavailable",
                                    detail: "Recognition keeps failing on this device (\(last)). The native engine stopped. Use the Web engine for this script.")
                    self.setInactive()
                    return
                }
                let backoffMs = min(2000.0, 50.0 * pow(2.0, Double(self.consecutiveFailures)))
                self.endedAtEpochMs = Date().timeIntervalSince1970 * 1000
                // unpublish the dead request: the tap must not keep
                // appending to it, and the watchdog must not count
                // voiced audio against a task that no longer exists
                self.request = nil
                self.emitStatus("restarting")
                DispatchQueue.main.asyncAfter(deadline: .now() + backoffMs / 1000.0) {
                    // a watchdog restart or stop during the backoff
                    // advances the generation — this respawn is stale
                    guard self.isActive, gen == self.liveGeneration() else { return }
                    self.spawnRecognitionTask(recognizer)
                }
            }
        }
    }

    // MARK: - tap-confirmed listening + audio level

    func armListeningConfirmation(detail: String) {
        meterLock.lock()
        pendingListeningDetail = detail
        meterLock.unlock()
    }

    /// Called from the audio thread (recognizer tap). Thread-safe.
    func onTapBuffer(_ buffer: AVAudioPCMBuffer) {
        let rms = Self.rms(of: buffer)
        // watchdog accounting: voiced milliseconds since the last
        // fresh result — only while a recognition request is live
        let bufMs = buffer.format.sampleRate > 0
            ? Double(buffer.frameLength) / buffer.format.sampleRate * 1000 : 0
        var fireMs: Double = 0
        var fireGen = 0
        meterLock.lock()
        if request != nil && rms >= Self.vadVoiceRms {
            watchdogVoicedMs += bufMs
            if watchdogVoicedMs >= Self.watchdogVoicedMaxMs && !watchdogPending {
                watchdogPending = true
                fireMs = watchdogVoicedMs
                fireGen = taskGeneration
            }
        }
        meterLock.unlock()
        reportLevel(rms: rms)
        if fireMs > 0 {
            // generation-stamped: if a rotation lands before this queued
            // closure runs, the restart is stale and must not double-
            // rotate inside the retire window
            DispatchQueue.main.async { self.watchdogRestart(voicedMs: fireMs, gen: fireGen) }
        }
    }

    /// Retire the live task and spawn a FRESH one, with overlap: the
    /// tap feeds both requests for rotationOverlapMs, the old task's
    /// results stay accepted until retireDeadlineMs, then it is
    /// cancelled. Used by proactive age rotation AND the watchdog
    /// (fresh-task-per-watchdog replaces resuscitation).
    private func rotateTask(reason: String) {
        guard isActive, request != nil, let recognizer = currentRecognizer else { return }
        emitStatus("rotating", detail: reason)
        let now = Date().timeIntervalSince1970 * 1000
        meterLock.lock()
        retiringGeneration = taskGeneration
        retiringUntilMs = now + Self.retireDeadlineMs
        meterLock.unlock()
        // unpublish FIRST: between these assignments a tap buffer may
        // miss both requests (~21ms, inaudible) — the reverse order
        // would double-append it to the same request via two aliases
        let oldRequest = request
        let oldTask = task
        request = nil
        task = nil
        retiringRequest = oldRequest
        retiringTask = oldTask
        spawnRecognitionTask(recognizer)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.rotationOverlapMs / 1000.0) { [weak self] in
            self?.retiringRequest?.endAudio()
            self?.retiringRequest = nil
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.retireDeadlineMs / 1000.0) { [weak self] in
            guard let self = self else { return }
            self.retiringTask?.cancel()
            self.retiringTask = nil
            self.meterLock.lock()
            if Date().timeIntervalSince1970 * 1000 >= self.retiringUntilMs {
                self.retiringGeneration = 0
            }
            self.meterLock.unlock()
        }
    }

    private func isRetiringGen(_ gen: Int) -> Bool {
        meterLock.lock()
        defer { meterLock.unlock() }
        return gen == retiringGeneration && retiringGeneration != 0
            && Date().timeIntervalSince1970 * 1000 < retiringUntilMs
    }

    private func clearRetiring(gen: Int) {
        meterLock.lock()
        let matches = gen == retiringGeneration
        if matches { retiringGeneration = 0 }
        meterLock.unlock()
        if matches {
            retiringTask = nil
            retiringRequest = nil
        }
    }

    /// The task has been fed ≥5s of voiced audio and returned nothing:
    /// hand it a FRESH task via the rotation machinery (overlap keeps
    /// buffer continuity; the wedged task is cancelled after its
    /// deadline; no failure count — this is a recovery, not a crash).
    private func watchdogRestart(voicedMs: Double, gen: Int) {
        guard isActive, request != nil, currentRecognizer != nil,
              gen == liveGeneration() else {
            meterLock.lock()
            watchdogPending = false
            watchdogVoicedMs = 0
            meterLock.unlock()
            return
        }
        emitStatus("restarting",
                   detail: "watchdog: \(Int(voicedMs))ms voiced speech, zero fresh tokens — fresh task")
        endedAtEpochMs = Date().timeIntervalSince1970 * 1000
        rotateTask(reason: "watchdog \(Int(voicedMs))ms voiced, zero tokens")
    }

    private func liveGeneration() -> Int {
        meterLock.lock()
        defer { meterLock.unlock() }
        return taskGeneration
    }

    /// Thread-safe level/listening reporting shared by both engines.
    func reportLevel(rms: Float) {
        var announce: String?
        var emitLevel: Int?
        var emitOnset: Double?
        let now = Date().timeIntervalSince1970 * 1000
        meterLock.lock()
        if let detail = pendingListeningDetail {
            pendingListeningDetail = nil
            announce = detail
        }
        if now - lastLevelEmitMs >= 1000 {
            lastLevelEmitMs = now
            emitLevel = min(100, Int(rms * 300))
        }
        // VAD onset: sustained sub-voice audio arms; two consecutive
        // voiced buffers fire exactly one onset. Quiet is defined as
        // "below the voice threshold" — the rig's room tone sits well
        // above a strict silence floor (device tapes: ambience at
        // level 1–2), and a separate quiet band silently preserved
        // arming credit through soft speech.
        if rms < Self.vadVoiceRms {
            vadVoicedStreak = 0
            if vadQuietSinceMs == 0 { vadQuietSinceMs = now }
            if now - vadQuietSinceMs >= Self.vadQuietMinMs { vadArmed = true }
        } else {
            vadQuietSinceMs = 0
            vadVoicedStreak += 1
            if vadArmed && vadVoicedStreak >= 2 {
                vadArmed = false
                emitOnset = now
            }
        }
        meterLock.unlock()
        if let announce = announce {
            DispatchQueue.main.async { self.emitStatus("listening", detail: announce) }
        }
        if let level = emitLevel {
            DispatchQueue.main.async { self.emitStatus("level", detail: String(level)) }
        }
        if let onset = emitOnset {
            DispatchQueue.main.async { self.emitStatus("voice-onset", detail: String(Int(onset))) }
        }
    }

    static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        let n = Int(buffer.frameLength)
        for i in 0..<n { sum += data[i] * data[i] }
        return sqrtf(sum / Float(n))
    }

    // MARK: - shared emission (also used by the analyzer engine)

    func emitWords(_ words: [String], ends: [Double], isFinal: Bool, engine: String, gen: Int = 0) {
        // the audio thread owns anchor writes — read under the lock.
        // A generation's words carry that generation's OWN anchor: a
        // retiring task's flush must not borrow the fresh task's.
        meterLock.lock()
        let anchor = gen > 0 ? (anchorByGen[gen] ?? sessionStartEpochMs) : sessionStartEpochMs
        meterLock.unlock()
        notifyListeners("words", data: [
            "words": words,
            "audioEndMs": ends,
            "isFinal": isFinal,
            "sessionStartEpochMs": anchor,
            "engine": engine,
            // stream tag: the JS diff keeps one transcript PER task —
            // rotation-overlap words from two tasks must never
            // interleave into one stream (that would re-create the
            // regurgitation the rotation exists to prevent)
            "gen": gen,
        ])
    }

    func emitStatus(_ status: String, detail: String? = nil) {
        var data: [String: Any] = ["status": status]
        if let detail = detail { data["detail"] = detail }
        notifyListeners("status", data: data)
    }

    func emitEnv(_ fields: [String: Any]) {
        var dict = fields
        dict["model"] = Self.deviceModelIdentifier()
        dict["os"] = UIDevice.current.systemVersion
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
            emitStatus("env", detail: json)
        }
    }

    func setSessionStart(epochMs: Double) {
        meterLock.lock()
        sessionStartEpochMs = epochMs
        meterLock.unlock()
    }

    var currentVocabulary: [String] { vocabulary }

    static func deviceModelIdentifier() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        return withUnsafeBytes(of: &sysinfo.machine) { buf in
            guard let base = buf.baseAddress else { return "unknown" }
            return String(cString: base.assumingMemoryBound(to: CChar.self))
        }
    }

    private func stopAll() {
        stateQueue.sync { active = false }
        meterLock.lock()
        pendingListeningDetail = nil
        anchorPending = false
        vadQuietSinceMs = 0
        vadVoicedStreak = 0
        vadArmed = false
        watchdogVoicedMs = 0
        watchdogPending = false
        taskGeneration += 1
        meterLock.unlock()
        currentRecognizer = nil
        rotationTimer?.cancel()
        rotationTimer = nil
        retiringTask?.cancel()
        retiringTask = nil
        retiringRequest = nil
        meterLock.lock()
        retiringGeneration = 0
        anchorByGen.removeAll()
        meterLock.unlock()
        task?.cancel()
        task = nil
        request = nil
        if #available(iOS 26.0, *) {
            if let analyzer = analyzerBox as? NativeSpeechAnalyzer {
                Task { @MainActor in analyzer.stop() }
            }
        }
        analyzerBox = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        emitStatus("stopped")
    }
}

/// Thrown by the analyzer when the hardware/locale cannot run
/// SpeechTranscriber at all — the caller falls back without error spam.
struct AnalyzerUnsupported: Error {
    let note: String
}
