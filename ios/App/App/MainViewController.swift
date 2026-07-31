import UIKit
import Capacitor

/// Registers the in-app NativeSpeech plugin with the Capacitor bridge.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeSpeechPlugin())
    }
}
