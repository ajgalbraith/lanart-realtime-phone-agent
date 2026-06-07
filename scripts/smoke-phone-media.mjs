#!/usr/bin/env node
import twilio from "twilio";
import WebSocket from "ws";
import { URLSearchParams } from "node:url";
import { loadTwilioConfig } from "../server/twilioConfig.js";

const VOICE_URL = "https://lanart-realtime-phone-agent.onrender.com/phone-agent/twilio/voice";
const MEDIA_URL = "wss://lanart-realtime-phone-agent.onrender.com/phone-agent/twilio/media";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAllowedStreamParams() {
  const config = loadTwilioConfig({ refresh: true });
  const callSid = `CATEST${Date.now()}`;
  const params = { From: "+14387870109", To: "+14388120333", CallSid: callSid };
  const signature = twilio.getExpectedTwilioSignature(config.authToken, VOICE_URL, params);
  const response = await fetch(VOICE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(params),
  });
  const twiml = await response.text();
  const sessionToken = twiml.match(/name="sessionToken" value="([^"]+)"/)?.[1];
  if (!response.ok || !sessionToken) throw new Error(`Could not get stream token: ${response.status} ${twiml}`);
  return { callSid, sessionToken };
}

async function testMedia({ callSid, sessionToken, expectReject }) {
  const ws = new WebSocket(MEDIA_URL);
  let opened = false;
  let closed = false;
  let closeCode = null;
  let closeReason = "";
  ws.on("open", () => {
    opened = true;
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ws.send(
      JSON.stringify({
        event: "start",
        start: {
          streamSid: `MZ${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
          callSid,
          customParameters: { callSid, sessionToken },
        },
      }),
    );
  });
  ws.on("close", (code, reason) => {
    closed = true;
    closeCode = code;
    closeReason = reason.toString();
  });

  await wait(expectReject ? 2500 : 8000);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: "stop", stop: { callSid } }));
    await wait(500);
    ws.close();
  }
  await wait(500);

  return { opened, closed, closeCode, closeReason };
}

const allowed = await getAllowedStreamParams();
const valid = await testMedia(allowed);
const invalid = await testMedia({ callSid: `CATESTBAD${Date.now()}`, sessionToken: "bad-token", expectReject: true });

if (!valid.opened || (valid.closed && valid.closeCode === 1008)) {
  throw new Error(`Valid media stream was rejected: ${JSON.stringify(valid)}`);
}
if (!invalid.closed || invalid.closeCode !== 1008) {
  throw new Error(`Invalid media stream was not rejected: ${JSON.stringify(invalid)}`);
}

console.log(JSON.stringify({ valid, invalid }, null, 2));
