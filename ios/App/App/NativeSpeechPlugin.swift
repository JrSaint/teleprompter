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
    ]

    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var localeId = "en-US"
    private var vocabulary: [String] = []
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
        return [
            "recordPermission": permission,
            "sessionCategory": session.category.rawValue,
            "sessionMode": session.mode.rawValue,
            "sessionSampleRate": session.sampleRate,
            "isInputAvailable": session.isInputAvailable,
        ]
    }

    // MARK: - SFSpeechRecognizer path (on-device required)

    private func startRecognizer() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
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
        // listen to nothing, never fall back to server-side here.
        guard recognizer.supportsOnDeviceRecognition else {
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
                }
                self.meterLock.unlock()
            }
            self.request?.append(buffer)
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
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        // B.3 engine levers: prompting is dictation-shaped, and
        // punctuation insertion only adds latency and re-statements
        req.taskHint = .dictation
        if #available(iOS 16.0, *) { req.addsPunctuation = false }
        if !vocabulary.isEmpty { req.contextualStrings = vocabulary }
        // Arm the anchor BEFORE publishing the request: the tap starts
        // appending the moment `request` is non-nil, and the anchor
        // must stamp that first appended buffer (the request's audio
        // t=0), not a later one. Provisional value covers the gap.
        meterLock.lock()
        sessionStartEpochMs = Date().timeIntervalSince1970 * 1000
        anchorPending = true
        meterLock.unlock()
        request = req
        wordsThisSession = false

        if endedAtEpochMs > 0 {
            let gap = Date().timeIntervalSince1970 * 1000 - endedAtEpochMs
            emitStatus("restart-gap", detail: String(Int(gap)))
            endedAtEpochMs = 0
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, self.isActive else { return }
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
                if !words.isEmpty {
                    self.wordsThisSession = true
                    self.consecutiveFailures = 0
                }
                self.emitWords(words, ends: ends, isFinal: result.isFinal, engine: "recognizer")
            }
            if let error = error {
                self.emitStatus("error", detail: "recognition task: \(error.localizedDescription)")
            }
            if error != nil || (result?.isFinal ?? false) {
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
                self.emitStatus("restarting")
                DispatchQueue.main.asyncAfter(deadline: .now() + backoffMs / 1000.0) {
                    if self.isActive { self.spawnRecognitionTask(recognizer) }
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
        reportLevel(rms: rms)
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

    func emitWords(_ words: [String], ends: [Double], isFinal: Bool, engine: String) {
        // the audio thread owns anchor writes — read under the lock
        meterLock.lock()
        let anchor = sessionStartEpochMs
        meterLock.unlock()
        notifyListeners("words", data: [
            "words": words,
            "audioEndMs": ends,
            "isFinal": isFinal,
            "sessionStartEpochMs": anchor,
            "engine": engine,
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
