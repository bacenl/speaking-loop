import { useCallback, useEffect, useRef, useState } from "react";
import { useMicVAD } from "@ricky0123/vad-react";

const USE_MOCK_VAD = import.meta.env.VITE_MOCK_VAD === "1";

function makeMockAudio() {
  const audio = new Float32Array(16000);
  for (let index = 0; index < audio.length; index += 1) {
    audio[index] = Math.sin(index / 8) * 0.2;
  }
  return audio;
}

function useMockVAD(options) {
  const [listening, setListening] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const callbacksRef = useRef(options);

  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const start = useCallback(async () => {
    setListening(true);
  }, []);

  const pause = useCallback(async () => {
    setListening(false);
  }, []);

  const toggle = useCallback(async () => {
    setListening((current) => !current);
  }, []);

  useEffect(() => {
    window.__speakingLoopVad = {
      startSpeech() {
        setUserSpeaking(true);
        callbacksRef.current.onSpeechStart?.();
        callbacksRef.current.onFrameProcessed?.(
          { isSpeech: 0.95, notSpeech: 0.05 },
          makeMockAudio().slice(0, 512),
        );
      },
      endSpeech() {
        setUserSpeaking(false);
        callbacksRef.current.onSpeechEnd?.(makeMockAudio());
      },
      misfire() {
        setUserSpeaking(false);
        callbacksRef.current.onVADMisfire?.();
      },
    };
    return () => {
      delete window.__speakingLoopVad;
    };
  }, []);

  return {
    listening,
    errored: false,
    loading: false,
    userSpeaking,
    pause,
    start,
    toggle,
  };
}

export function useAppVAD(options) {
  if (USE_MOCK_VAD) return useMockVAD(options);
  return useMicVAD(options);
}
