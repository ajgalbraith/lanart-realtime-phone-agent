export const REALTIME_MODEL = "gpt-realtime-2.1-mini";

export const GPT_REALTIME_2_1_MINI_PRICING = {
  text: {
    input: 0.6,
    cachedInput: 0.06,
    output: 2.4,
  },
  audio: {
    input: 10,
    cachedInput: 0.3,
    output: 20,
  },
  image: {
    input: 0.8,
    cachedInput: 0.08,
    output: 0,
  },
};

export const GPT_4O_MINI_TRANSCRIBE_PRICING = {
  input: 1.25,
  output: 5,
};

const PER_MILLION = 1_000_000;

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function billableTokens(total, cached) {
  return Math.max(0, positiveNumber(total) - positiveNumber(cached));
}

export function estimateRealtimeCost(usage) {
  if (!usage || typeof usage !== "object") {
    return { usd: 0, breakdown: {} };
  }

  const inputDetails = usage.input_token_details ?? {};
  const outputDetails = usage.output_token_details ?? {};
  const cachedDetails = inputDetails.cached_tokens_details ?? {};

  const inputText = positiveNumber(inputDetails.text_tokens);
  const inputAudio = positiveNumber(inputDetails.audio_tokens);
  const inputImage = positiveNumber(inputDetails.image_tokens);
  const cachedText = positiveNumber(cachedDetails.text_tokens);
  const cachedAudio = positiveNumber(cachedDetails.audio_tokens);
  const cachedImage = positiveNumber(cachedDetails.image_tokens);

  const outputText = positiveNumber(outputDetails.text_tokens);
  const outputAudio = positiveNumber(outputDetails.audio_tokens);
  const knownOutput = outputText + outputAudio;
  const uncategorizedOutput = Math.max(0, positiveNumber(usage.output_tokens) - knownOutput);

  const fallbackInput = Math.max(
    0,
    positiveNumber(usage.input_tokens) - inputText - inputAudio - inputImage,
  );

  const textInputCost =
    ((billableTokens(inputText + fallbackInput, cachedText) * GPT_REALTIME_2_1_MINI_PRICING.text.input) +
      cachedText * GPT_REALTIME_2_1_MINI_PRICING.text.cachedInput) /
    PER_MILLION;
  const audioInputCost =
    ((billableTokens(inputAudio, cachedAudio) * GPT_REALTIME_2_1_MINI_PRICING.audio.input) +
      cachedAudio * GPT_REALTIME_2_1_MINI_PRICING.audio.cachedInput) /
    PER_MILLION;
  const imageInputCost =
    ((billableTokens(inputImage, cachedImage) * GPT_REALTIME_2_1_MINI_PRICING.image.input) +
      cachedImage * GPT_REALTIME_2_1_MINI_PRICING.image.cachedInput) /
    PER_MILLION;
  const textOutputCost =
    ((outputText + uncategorizedOutput) * GPT_REALTIME_2_1_MINI_PRICING.text.output) / PER_MILLION;
  const audioOutputCost = (outputAudio * GPT_REALTIME_2_1_MINI_PRICING.audio.output) / PER_MILLION;

  const breakdown = {
    textInputCost,
    audioInputCost,
    imageInputCost,
    textOutputCost,
    audioOutputCost,
  };

  return {
    usd: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown,
  };
}

export function estimateTranscriptionCost(usage) {
  if (!usage || typeof usage !== "object") {
    return { usd: 0, breakdown: {} };
  }

  const inputCost = (positiveNumber(usage.input_tokens) * GPT_4O_MINI_TRANSCRIBE_PRICING.input) / PER_MILLION;
  const outputCost = (positiveNumber(usage.output_tokens) * GPT_4O_MINI_TRANSCRIBE_PRICING.output) / PER_MILLION;
  const breakdown = { transcriptionInputCost: inputCost, transcriptionOutputCost: outputCost };

  return {
    usd: inputCost + outputCost,
    breakdown,
  };
}
