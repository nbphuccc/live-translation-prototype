import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Not connected");
  const [role, setRole] = useState<"host" | "attendee" | null>(null);
  const [glossaryContent, setGlossaryContent] = useState<string>("");
  const [captions, setCaptions] = useState<string[]>([]);
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  useEffect(() => {
    const socket = io(BACKEND_URL);
    socketRef.current = socket;
    socket.on("connect", () => setStatus("Connected to backend"));

    socket.on("room-created", (id: string) => {
      setRoomId(id);
      setRole("host");
      setStatus(`Room hosted successfully!`);
    });

    socket.on("room-joined", (id: string) => {
      setRoomId(id);
      setRole("attendee");
      setStatus(`Joined room successfully`);
    });

    socket.on("no-room", () => setStatus("No room available to join yet."));

    return () => {
      socket.off("room-created");
      socket.off("room-joined");
      socket.off("no-room");
    };
  }, []);

  useEffect(() => {
  if (role !== "attendee" || !socketRef.current) return;

  const socket = socketRef.current;
  const audioCtx = new AudioContext();

  // 🎧 Receive audio and play immediately
  socket.on("audio-stream", async (data: { buffer: ArrayBuffer; timestamp: number }) => {
    try {
      const int16 = new Int16Array(data.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x7fff;

      const audioBuffer = audioCtx.createBuffer(1, float32.length, audioCtx.sampleRate);
      audioBuffer.getChannelData(0).set(float32);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start();
    } catch (err) {
      console.error("Error playing audio chunk:", err);
    }
  });

  // Receive captions and display immediately
  socket.on(
  "translated-caption",
  (data: { transcript: string; translation: string; timestamp: number }) => {
    setCaptions(prev => {
      const cleaned = data.translation
        .trim()
        .replace(/^"(.*)"$/, "$1")   // remove wrapping quotes if present
        .replace(/^'+|'+$/g, "");    // also handle single quotes
      const filtered = [...prev, cleaned].filter(t => t !== "");
      return filtered.slice(-5);
    });

    setTranscripts(prev => {
      const cleaned = data.transcript.trim();
      const filtered = [...prev, cleaned].filter(t => t !== "");
      return filtered.slice(-5);
    });
  }
);
  // Cleanup on unmount
  return () => {
    socket.off("audio-stream");
    socket.off("translated-caption");
    audioCtx.close();
  };
}, [role]);

  const handleHost = () => {
    const socket = socketRef.current;
  if (!socket) {
    console.error("Socket not initialized yet!");
    return;
  }
    setStatus("Creating new room...");
    socket.emit("host-room");
  };

  const handleJoin = () => {
    const socket = socketRef.current;
  if (!socket) {
    console.error("Socket not initialized yet!");
    return;
  }
    setStatus("Attempting to join room...");
    socket.emit("join-room");
  };

  const handleParsingGlossary = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0]; 
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target?.result;
    if (typeof text === "string") {
      setGlossaryContent(text); // store parsed CSV locally
      console.log("Parsed glossary CSV content:", text);
    }
  };
  reader.readAsText(file);
};

const handleGlossaryUpload = async () => {
  if (!glossaryContent) {
    console.warn("No glossary content to upload");
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/upload-glossary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: glossaryContent }),
    });
    const data = await res.json();
    console.log("Backend response:", data);

    // Show success message
    setFlashMessage("Glossary uploaded!");
    setTimeout(() => setFlashMessage(null), 2500);
  } catch (err) {
    console.error("Error sending glossary to backend:", err);
  }
};

  // This is the main place where balance must be maintain. Chunks too short make the audio choppy, but chunks too long makes the delay too long
  const CHUNK_MS = 5000; // chunk length in ms

const handleStartMeeting = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);

    // Load worklet
    await audioCtx.audioWorklet.addModule('/pcm-processor.js');

    // Create worklet node
    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
    source.connect(workletNode);
    workletNode.connect(audioCtx.destination); // optional for monitoring

    // Accumulate frames for larger chunks
    const framesPerChunk = Math.floor(audioCtx.sampleRate * (CHUNK_MS / 1000));
    let pcmBufferQueue: Float32Array[] = [];
    let queuedFrames = 0;

    workletNode.port.onmessage = (event) => {
      const float32Array = event.data as Float32Array;
      pcmBufferQueue.push(float32Array);
      queuedFrames += float32Array.length;

      if (queuedFrames >= framesPerChunk) {
        // Merge into one chunk
        const merged = mergeFloat32Arrays(pcmBufferQueue);
        const buffer = float32To16BitPCM(merged);
        const timestamp = Date.now();
        socketRef.current?.emit('audio-chunk', { buffer, timestamp });

        // Reset queue
        pcmBufferQueue = [];
        queuedFrames = 0;
      }
    };

    console.log("Meeting started, sending larger PCM audio chunks via AudioWorklet");
    setFlashMessage("Meeting Started!");
    setTimeout(() => setFlashMessage(null), 2500);
  } catch (err) {
    console.error("Error starting meeting:", err);
  }
};

// Merge multiple Float32Array frames into one
function mergeFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const length = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Helper: convert Float32Array [-1,1] to Int16 PCM
function float32To16BitPCM(float32Array: Float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function parseCSV(csv: string): string[][] {
  // Simple CSV parser (split by line, then by comma)
  return csv
    .trim()
    .split("\n")
    .map(line => line.split(",").map(cell => cell.trim()));
}

  return (
    <div className="page-container">
  {/* Left column: main container (title, buttons, host/attendee views) */}
  <div className="main-container">
    <div className="container">
      <h1>🎧 Live Translation Prototype</h1>
      <p className="status">Status: {status}</p>

      {!roomId && (
        <div className="button-group">
          <button className="btn host" onClick={handleHost}>
            Host Room
          </button>
          <button className="btn join" onClick={handleJoin}>
            Join Room
          </button>
        </div>
      )}

      {roomId && (
        <div className="room-info">
          <h2>Active Room ID: {roomId}</h2>
          <p>
            You are the <strong>{role === "host" ? "Host" : "Attendee"}</strong>
          </p>
        </div>
      )}

      {role === "host" && (
        <div className="host-controls">
          <h2>Host Controls</h2>
          <button className="btn-upload" onClick={handleGlossaryUpload}>
            Upload Glossary
          </button>

          <input
            type="file"
            id="glossary-input"
            accept=".csv"
            onChange={handleParsingGlossary}
          />

          <button className="btn-start" onClick={handleStartMeeting}>
            Start Meeting
          </button>

          {flashMessage && <div className="flash-message">{flashMessage}</div>}
        </div>
      )}

      {role === "attendee" && (
        <div className="attendee-view">

          <div className="trans-caption-container">
            {/* Left: Original transcript */}
            <div className="transcript-display">
              <h3>Transcript</h3>
              {transcripts.length > 0 ? (
                transcripts.map((line, i) => <p key={i}>{line}</p>)
              ) : (
                <p className="placeholder">Waiting for speech...</p>
              )}
            </div>

            {/* Right: Translated captions */}
            <div className="caption-display">
              <h3>Translation</h3>
              {captions.length > 0 ? (
                captions.map((line, i) => <p key={i}>{line}</p>)
              ) : (
                <p className="placeholder">Waiting for translation...</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  </div>

  {/* Right column: glossary full-size */}
  {glossaryContent && (
    <div className="glossary-full-container">
      <h2>Uploaded Glossary</h2>
      <table>
        <thead>
          <tr>
            <th>Original</th>
            <th>Translation</th>
          </tr>
        </thead>
        <tbody>
          {parseCSV(glossaryContent).map((row, i) => (
            <tr key={i}>
              <td>{row[0]}</td>
              <td>{row[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )}
</div>

  );
}

export default App;
