interface AwakeningOrbProps {
  state: "dormant" | "awakening" | "breathing" | "listening" | "transitioning";
  audioLevel?: number; // 0-100 for voice input visualization
}

export function AwakeningOrb({ state, audioLevel = 0 }: AwakeningOrbProps) {
  // Determine CSS classes based on state
  const orbClasses = [
    "onboarding-orb",
    state === "awakening" && "awakening",
    state === "breathing" && "breathing",
    state === "listening" && "listening",
    state === "transitioning" && "transitioning",
  ]
    .filter(Boolean)
    .join(" ");

  // Scale orb slightly based on audio level when listening
  const orbStyle =
    state === "listening" && audioLevel > 0
      ? {
          transform: `scale(${1 + audioLevel * 0.003})`,
        }
      : undefined;

  // Show waveform ripples when listening and there's audio input
  const showWaveform = state === "listening" && audioLevel > 20;

  if (state === "dormant") {
    return null;
  }

  return (
    <div className="onboarding-orb-container">
      <div className={orbClasses} style={orbStyle} />
      <div className={`onboarding-waveform ${showWaveform ? "active" : ""}`}>
        <div className="onboarding-waveform-ring" />
        <div className="onboarding-waveform-ring" />
        <div className="onboarding-waveform-ring" />
      </div>
    </div>
  );
}

export default AwakeningOrb;
