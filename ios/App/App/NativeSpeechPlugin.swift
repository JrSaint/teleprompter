import Foundation
import Capacitor
import Speech
import AVFoundation
import UIKit

/**
 * On-device speech for the voice prompter.
 *
 * Engine selection at runtime:
 *  - iPadOS 26+: SpeechAnalyzer/SpeechTranscriber (word-level audio
 *    time ranges) — see NativeSpeechAnalyzer.swift.
 *  - Otherwise/fallback: SFSpeechRecognizer with
 *    requiresOnDeviceRecognition and contextualStrings vocabulary.
 *
 * Hardening (B.2 bugfix sprint):
 *  - start/stop are idempotent — a second start while active is a no-op
 *  - "listening" is emitted only after the audio tap delivers its first
 *    buffer; a ~1Hz RMS level event proves audio is flowing
 *  - every failure emits a status event with detail — nothing dies
 *    silently in the Xcode console
 *  - an "env" event reports device/OS/engine/locale state at start
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
    private var active = false
    private var localeId = "en-US"
    private var vocabulary: [String] = []
    private var sessionStartEpochMs: Double = 0
    private var endedAtEpochMs: Double = 0
    private var analyzerBox: AnyObject?

    // tap-confirmed listening + level metering
    private var pendingListeningDetail: String?
    private var lastLevelEmitMs: Double = 0

    @objc func start(_ call: CAPPluginCall) {
        // idempotent: a second start while active is a no-op
        if active {
            emitStatus("starting", detail: "already active — start ignored")
            call.resolve()
            return
        }
        active = true
        localeId = call.getString("locale") ?? "en-US"
        vocabulary = call.getArray("vocabulary", String.self) ?? []
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            guard let self = self else { return }
            guard auth == .authorized else {
                self.active = false
                self.emitStatus("denied", detail: "speech recognition not authorized")
                call.resolve()
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    self.active = false
                    self.emitStatus("denied", detail: "microphone not authorized")
                    call.resolve()
                    return
                }
                DispatchQueue.main.async {
                    self.begin()
                    call.resolve()
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopAll()
        call.resolve()
    }

    private func begin() {
        emitStatus("starting")
        if #available(iOS 26.0, *) {
            let analyzer = NativeSpeechAnalyzer(plugin: self, localeId: localeId)
            analyzerBox = analyzer
            analyzer.start { [weak self] ok in
                guard let self = self, self.active else { return }
                if !ok {
                    self.analyzerBox = nil
                    self.emitStatus("restarting", detail: "analyzer unavailable, falling back")
                    DispatchQueue.main.async { self.startRecognizer() }
                }
            }
        } else {
            startRecognizer()
        }
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
        // On-device policy: check BEFORE forcing it; never silently
        // listen to nothing, never fall back to server-side here.
        let supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted()
        emitEnv(engine: "recognizer",
                resolvedLocale: recognizer.locale.identifier,
                onDevice: recognizer.supportsOnDeviceRecognition,
                supported: Array(supported.prefix(40)),
                installed: [])
        guard recognizer.supportsOnDeviceRecognition else {
            emitStatus("unavailable",
                       detail: "This iPad cannot run \(localeId) speech recognition on-device. The native engine never sends audio to servers, so it cannot continue. Use the Web engine for this script.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            emitStatus("error", detail: "audio session failed: \(error.localizedDescription)")
            return
        }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitStatus("error", detail: "microphone reports an invalid audio format (\(format.sampleRate) Hz)")
            return
        }
        pendingListeningDetail = "recognizer"
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.onTapBuffer(buffer)
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
        if !vocabulary.isEmpty { req.contextualStrings = vocabulary }
        request = req

        if endedAtEpochMs > 0 {
            let gap = Date().timeIntervalSince1970 * 1000 - endedAtEpochMs
            emitStatus("restart-gap", detail: String(Int(gap)))
            endedAtEpochMs = 0
        }
        sessionStartEpochMs = Date().timeIntervalSince1970 * 1000

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self, self.active else { return }
            if let result = result {
                var words: [String] = []
                var ends: [Double] = []
                for seg in result.bestTranscription.segments {
                    words.append(seg.substring)
                    ends.append((seg.timestamp + seg.duration) * 1000)
                }
                self.emitWords(words, ends: ends, isFinal: result.isFinal, engine: "recognizer")
            }
            if let error = error {
                self.emitStatus("error", detail: "recognition task: \(error.localizedDescription)")
            }
            if error != nil || (result?.isFinal ?? false) {
                self.endedAtEpochMs = Date().timeIntervalSince1970 * 1000
                self.emitStatus("restarting")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    if self.active { self.spawnRecognitionTask(recognizer) }
                }
            }
        }
    }

    // MARK: - tap-confirmed listening + audio level (both engines)

    func armListeningConfirmation(detail: String) {
        pendingListeningDetail = detail
    }

    func onTapBuffer(_ buffer: AVAudioPCMBuffer) {
        if let detail = pendingListeningDetail {
            pendingListeningDetail = nil
            DispatchQueue.main.async { self.emitStatus("listening", detail: detail) }
        }
        let now = Date().timeIntervalSince1970 * 1000
        guard now - lastLevelEmitMs >= 1000 else { return }
        lastLevelEmitMs = now
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        let n = Int(buffer.frameLength)
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = sqrtf(sum / Float(n))
        let level = min(100, Int(rms * 300))
        DispatchQueue.main.async { self.emitStatus("level", detail: String(level)) }
    }

    // MARK: - shared emission (also used by the analyzer engine)

    func emitWords(_ words: [String], ends: [Double], isFinal: Bool, engine: String) {
        notifyListeners("words", data: [
            "words": words,
            "audioEndMs": ends,
            "isFinal": isFinal,
            "sessionStartEpochMs": sessionStartEpochMs,
            "engine": engine,
        ])
    }

    func emitStatus(_ status: String, detail: String? = nil) {
        var data: [String: Any] = ["status": status]
        if let detail = detail { data["detail"] = detail }
        notifyListeners("status", data: data)
    }

    func emitEnv(engine: String, resolvedLocale: String, onDevice: Bool,
                 supported: [String], installed: [String]) {
        let dict: [String: Any] = [
            "model": Self.deviceModelIdentifier(),
            "os": UIDevice.current.systemVersion,
            "engine": engine,
            "onDevice": onDevice,
            "locale": resolvedLocale,
            "supported": supported,
            "installed": installed,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
            emitStatus("env", detail: json)
        }
    }

    func setSessionStart(epochMs: Double) {
        sessionStartEpochMs = epochMs
    }

    var isActive: Bool { active }
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
        active = false
        pendingListeningDetail = nil
        task?.cancel()
        task = nil
        request = nil
        if #available(iOS 26.0, *) {
            (analyzerBox as? NativeSpeechAnalyzer)?.stop()
        }
        analyzerBox = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        emitStatus("stopped")
    }
}
