import { useState, useEffect, useCallback, useRef } from "react";

interface TypewriterTextProps {
  text: string;
  speed?: number; // milliseconds per character
  onComplete?: () => void;
  showCursor?: boolean;
  className?: string;
}

export function TypewriterText({
  text,
  speed = 50,
  onComplete,
  showCursor = true,
  className = "",
}: TypewriterTextProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    // Reset when text changes
    setDisplayedText("");
    setIsComplete(false);

    if (!text) {
      setIsComplete(true);
      onCompleteRef.current?.();
      return;
    }

    let currentIndex = 0;
    const intervalId = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplayedText(text.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(intervalId);
        setIsComplete(true);
        onCompleteRef.current?.();
      }
    }, speed);

    return () => clearInterval(intervalId);
  }, [text, speed]);

  return (
    <div className={`onboarding-typewriter ${className}`}>
      <span>{displayedText}</span>
      {showCursor && (
        <span className={`onboarding-typewriter-cursor ${isComplete ? "hidden" : ""}`} />
      )}
    </div>
  );
}

// Hook version for more control
export function useTypewriter(text: string, speed = 50) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const [isTyping, setIsTyping] = useState(false);

  const start = useCallback(() => {
    setDisplayedText("");
    setIsComplete(false);
    setIsTyping(true);
  }, []);

  const skip = useCallback(() => {
    setDisplayedText(text);
    setIsComplete(true);
    setIsTyping(false);
  }, [text]);

  useEffect(() => {
    if (!isTyping || !text) return;

    let currentIndex = 0;
    const intervalId = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplayedText(text.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(intervalId);
        setIsComplete(true);
        setIsTyping(false);
      }
    }, speed);

    return () => clearInterval(intervalId);
  }, [text, speed, isTyping]);

  return {
    displayedText,
    isComplete,
    isTyping,
    start,
    skip,
  };
}

export default TypewriterText;
