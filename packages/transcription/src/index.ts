export * from "./config";
export * from "./types";
export * from "./errors";
export * from "./openrouter-transcription";
export * from "./openrouter-normalization";
export * from "./azure-mai-transcription";

import { AzureMaiTranscriptionProvider } from "./azure-mai-transcription";
import { OpenRouterTranscriptionProvider } from "./openrouter-transcription";
import type { TranscriptionProvider } from "./types";

export interface TranscriptionFactoryConfig {
  primaryProvider?: "azure-mai" | "openrouter";
  azureMai?: {
    endpoint?: string;
    apiKey?: string;
    region?: string;
    model?: string;
  };
  openRouter?: {
    apiKey?: string;
    model?: string;
  };
}

export function createTranscriptionProvider(
  config: TranscriptionFactoryConfig,
): TranscriptionProvider {
  if (
    config.primaryProvider === "azure-mai" &&
    config.azureMai?.endpoint &&
    config.azureMai?.apiKey
  ) {
    return new AzureMaiTranscriptionProvider(
      config.azureMai.endpoint,
      config.azureMai.apiKey,
      config.azureMai.region,
      config.azureMai.model,
    );
  }
  if (config.openRouter?.apiKey) {
    return new OpenRouterTranscriptionProvider(
      config.openRouter.apiKey,
      config.openRouter.model,
    );
  }
  if (config.azureMai?.endpoint && config.azureMai?.apiKey) {
    return new AzureMaiTranscriptionProvider(
      config.azureMai.endpoint,
      config.azureMai.apiKey,
      config.azureMai.region,
      config.azureMai.model,
    );
  }
  throw new Error(
    "No valid transcription provider could be constructed from configuration.",
  );
}
