import Foundation
import Capacitor
import Speech
import AVFoundation

/**
 * On-device speech for the voice prompter.
 *
 * Engine selection at runtime:
 *  - iPadOS 26+: SpeechAnalyzer/SpeechTranscriber (word-level audio
 *    time ranges) — see NativeSpeechAnalyzer.swift.
 *  - Otherwise/fallback: SFSpeechRecognizer with
 *    requiresOnDeviceRecognition and contextualStrings vocabulary.
 *
 * Events:
 *  - "words":  { words: [String] (full session transcript so far),
 *                audioEndMs: [Double], isFinal: Bool,
 *                sessionStartEpochMs: Double, engine: String }
 *  - "status": { status: String, detail?: String }
 *    status includes "restart-gap" with detail = gap in ms.
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

    @objc func start(_ call: CAPPluginCall) {
        localeId = call.getString("locale") ?? "en-US"
        vocabulary = call.getArray("vocabulary", String.self) ?? []
        active = true
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            guard let self = self else { return }
            guard auth == .authorized else {
                self.emitStatus("denied", detail: "speech recognition not authorized")
                call.resolve()
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
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
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
              recognizer.isAvailable else {
            emitStatus("unavailable", detail: "recognizer unavailable for \(localeId)")
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            emitStatus("unavailable", detail: "on-device recognition unsupported for \(localeId)")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            emitStatus("error", detail: "audio session: \(error.localizedDescription)")
            return
        }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emitStatus("error", detail: "audio engine: \(error.localizedDescription)")
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
        emitStatus("listening", detail: "recognizer")

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
            if error != nil || (result?.isFinal ?? false) {
                // session ended — measure the gap and respawn
                self.endedAtEpochMs = Date().timeIntervalSince1970 * 1000
                self.emitStatus("restarting")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    if self.active { self.spawnRecognitionTask(recognizer) }
                }
            }
        }
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

    func setSessionStart(epochMs: Double) {
        sessionStartEpochMs = epochMs
    }

    var isActive: Bool { active }

    private func stopAll() {
        active = false
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
