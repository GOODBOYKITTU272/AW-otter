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

/**
 * Builds the primary TranscriptionProvider for a runtime.
 *
 * When `primaryProvider` is explicitly `"azure-mai"`, Azure credentials are
 * required — we refuse to silently fall through to OpenRouter/Whisper. That
 * prevents production from advertising Azure primary while accidentally
 * serving Whisper because AZURE_MAI_* was missing.
 *
 * The code-level default remains conservative (`openrouter`) at call sites;
 * production must set TRANSCRIPTION_PRIMARY_PROVIDER=azure-mai explicitly.
 */
export function createTranscriptionProvider(
  config: TranscriptionFactoryConfig,
): TranscriptionProvider {
  if (config.primaryProvider === "azure-mai") {
    if (!config.azureMai?.endpoint || !config.azureMai?.apiKey) {
      throw new Error(
        'TRANSCRIPTION_PRIMARY_PROVIDER is "azure-mai" but AZURE_MAI_ENDPOINT/AZURE_MAI_KEY are missing. Refusing silent OpenRouter fallback.',
      );
    }
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
