function Dashboard(): React.JSX.Element {
  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-mark">◉</div>
        <div>
          <h1>WoVoice for macOS</h1>
          <p>Speak naturally. Get clear, ready-to-use text — on your Mac.</p>
        </div>
      </header>

      <section className="card">
        <h2>Phase E1 — scaffold</h2>
        <p>
          The Electron shell is in place: tray, dashboard window, and the build/packaging
          pipeline. Dictation (global trigger, waveform overlay, Worker transcription)
          lands in the next phases.
        </p>
      </section>

      <section className="card">
        <h2>Coming in this build-out</h2>
        <ul>
          <li>Hold ⌥Space or middle-click anywhere to dictate</li>
          <li>Live waveform overlay; text pastes at your cursor</li>
          <li>Home · History · Dictionary · Settings, like your phone</li>
          <li>Same WoVoice account, quota, and encrypted sync</li>
        </ul>
      </section>
    </div>
  )
}

export default Dashboard
