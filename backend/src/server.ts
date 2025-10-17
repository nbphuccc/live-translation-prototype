import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import os from "os";
import { spawn } from "child_process";

dotenv.config();

const app = express();
app.use(cors());

/// should make its own .ts
export const INADMISSIBLE_PATTERNS: RegExp[] = [
  // empty / whitespace-only
  /^\s*$/,

  // single stray words
  /^(you|okay|yes|no|um+|hmm+|hi)[.!?]*$/i,

  // "Thank you" / sign-off / farewell lines
  /^thank you[.!?]*$/i,
  /^thank you for joining us[.!?]*$/i,
  /^thank you for watching[.!?]*$/i,
  /^thank you for having me[.!?]*$/i,
  /^thank you for joining us[.!?]* we'll see you next time[.!?]*$/i,
  /^thank you for listening[.!?]*$/i,
  /^bye[.!?]*$/i,
  /^bye[-\s]?bye[.!?]*$/i,
  /^goodbye[.!?]*$/i,
  /^see you( later| next time)?[.!?]*$/i,

  // newly added: outro / comment request / auto-transcription footers
  /^let me know in the comments what you think[.!?]*$/i,
  /^transcribed by https?:\/\/\S+/i,
  /^thanks for watching[.!?]*$/i,
  /^excited!? thanks for watching[.!?]*$/i,

  // filler expansions & generic phrases
  /subscribe/i,
  /this podcast/i,
  /visit our website/i,

  // nonverbal / background descriptions
  /\b(music|applause|laughter|noise|static|crowd)\b/i,

  // website / URL insertion
  /\b(www\.[^\s]+)/i,

  // placeholders / bracketed tokens
  /^\[.*\]$/, /^\(.*\)$/, /^(<.*>)$/i,

  // language switch / non-ASCII runs
  /[^\x00-\x7F]{3,}/,

  // repetition (same word 3+ times)
  /\b(\w+)\b(?:\s+\1){2,}/i,

  // short fragments / single letters
  /^\s*[a-zA-Z]\s*$/,

  // hallucinatory continuations or expansions
  /\b(and so on|etc)\b/i,
  /(and then).*\1/,

  // 🚫 emojis or emoji-containing lines
  /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u,
];

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
/*
//const DELAY_MS = 0; // intentional delay for "live translation"
const pendingChunks: {
  buffer: ArrayBuffer;
  timestamp: number;
  translation: string;
}[] = [];
 */
// In-memory store for prototype (single host session)
let glossaryCSV: string | null = null;

let activeRoomId: string | null = null; // store only one room for now

/**
 * Transcode raw PCM 16-bit buffer to WAV using FFmpeg and save to temp file
 */
async function transcodeToWavTempFile(rawBuffer: ArrayBuffer, sampleRate = 48000): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempInput = path.join(os.tmpdir(), `input-${Date.now()}.raw`);
    const tempOutput = path.join(os.tmpdir(), `output-${Date.now()}.wav`);

    // Save raw PCM to temp file
    fs.writeFileSync(tempInput, Buffer.from(rawBuffer));

    // Spawn FFmpeg to convert raw PCM to WAV 16kHz mono
    const ffmpegArgs = [
      "-y",
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", tempInput,
      "-ar", "16000",
      "-ac", "1",
      "-acodec", "pcm_s16le",
      tempOutput,
    ];

    const ff = spawn("ffmpeg", ffmpegArgs);

    /*
    ff.stderr.on("data", (data) => {
      // optional: log ffmpeg output for debugging
      // console.log("ffmpeg:", data.toString());
    });
    */

    ff.on("close", (code) => {
      fs.unlinkSync(tempInput); // delete input raw file
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}`));
        return;
      }
      resolve(tempOutput); // return path to WAV
    });
  });
}

/**
 * Transcribe audio using Whisper
 */

export async function transcribeAudio(rawBuffer: ArrayBuffer): Promise<string> {
  try {
    const wavPath = await transcodeToWavTempFile(rawBuffer);

    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
      response_format: "text",
    });

    fs.unlinkSync(wavPath);

    let text = response.trim();

    // Reject inadmissible outputs
    const invalid = INADMISSIBLE_PATTERNS.some((p) => p.test(text));
    if (invalid || text.length < 3) {
      console.warn("Filtered inadmissible transcription:", text);
      return "";
    }

    return text;
  } catch (err) {
    console.error("Whisper transcription error:", err);
    return "";
  }
}

function parseGlossaryCSV(csv: string | null): Record<string, string> {
  if (!csv) return {};
  const lines = csv.trim().split("\n").slice(1); // skip header
  const glossary: Record<string, string> = {};
  for (const line of lines) {
    const [source, target] = line.split(",");
    if (source && target) glossary[source.trim()] = target.trim();
  }
  return glossary;
}

async function translateTextGPT(
  text: string,
  targetLang = "vi",
  glossaryCSV: string
): Promise<string> {
  if (!text.trim()) return "";

  const glossary = parseGlossaryCSV(glossaryCSV);

  // Create glossary instructions
  const glossaryInstructions = Object.entries(glossary)
    .map(([en, vn]) => `"${en}" → "${vn}"`)
    .join(", ");

  const prompt = `
You are a translation assistant. Translate all text from English to Vietnamese.
Use these glossary rules: ${glossaryInstructions}.
Always preserve technical terms exactly as specified.
Translate the following text:
"${text}"
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // fast and cost-efficient
      messages: [{ role: "user", content: prompt }],
      temperature: 0, // deterministic output
    });

    // The translated text is in the first message's content
    return response.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("OpenAI translation error:", err);
    return "";
  }
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("host-room", () => {
    // Generate a random roomId
    activeRoomId = Math.random().toString(36).substring(2, 8);
    socket.join(activeRoomId);
    console.log("Room created:", activeRoomId);

    // Notify host that room was created
    socket.emit("room-created", activeRoomId);
  });

  socket.on("join-room", () => {
    if (activeRoomId) {
      socket.join(activeRoomId);
      //console.log("Client joined room:", activeRoomId);

      // Send existing roomId to the joining user
      socket.emit("room-joined", activeRoomId);
    } else {
      socket.emit("no-room");
    }
  });

// 1️⃣ Receive audio chunks from host
socket.on("audio-chunk", async (data) => {
  const { buffer, timestamp } = data;

  try {
    // 2️⃣ Process: transcribe + translate immediately
    const transcript = await transcribeAudio(buffer);
    console.log(transcript);

    const translation = await translateTextGPT(transcript, "vi", glossaryCSV!);
    console.log(translation);

    // 3️⃣ Send both audio and translation instantly to attendees
    io.to(activeRoomId).emit("audio-stream", { buffer, timestamp });
    io.to(activeRoomId).emit("translated-caption", { transcript, translation, timestamp });
  } catch (err) {
    console.error("Error processing audio chunk:", err);
  }
});

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Endpoint to receive glossary CSV from frontend
app.post("/upload-glossary", (req, res) => {
  const { csv } = req.body;
  if (!csv) {
    return res.status(400).json({ message: "No CSV provided" });
  }
  glossaryCSV = csv;
  console.log("Received glossary CSV:\n", glossaryCSV);
  return res.status(200).json({ message: "Glossary stored successfully" });
});

// Endpoint to get glossary (for testing / attendees)
app.get("/glossary", (req, res) => {
  if (!glossaryCSV) return res.status(404).json({ message: "No glossary found" });
  return res.status(200).send(glossaryCSV);
});

const PORT = 5000;
server.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
