export * from "./config";
export * from "./types";
export * from "./errors";
export * from "./openrouter-transcription";
export * from "./openrouter-normalization";
export * from "./azure-mai-transcription";
export * from "./sarvam-transcription";

import { AzureMaiTranscriptionProvider } from "./azure-mai-transcription";
import { OpenRouterTranscriptionProvider } from "./openrouter-transcription";
import { SarvamTranscriptionProvider } from "./sarvam-transcription";
import type { TranscriptionProvider } from "./types";

export type TranscriptionPrimaryProviderName =
  | "azure-mai"
  | "sarvam"
  | "openrouter";

export interface TranscriptionFactoryConfig {
  primaryProvider?: TranscriptionPrimaryProviderName;
  azureMai?: {
    endpoint?: string;
    apiKey?: string;
    region?: string;
    model?: string;
  };
  sarvam?: {
    apiKey?: string;
    model?: string;
    mode?: string;
  };
  openRouter?: {
    apiKey?: string;
    model?: string;
  };
}

/**
 * Builds the primary TranscriptionProvider for a runtime.
 *
 * Explicit `primaryProvider` values require their credentials — we refuse
 * silent fallthrough to another provider. Fallback chaining is owned by
 * the domain layer (Phase 3), not this factory.
 *
 * Call-site defaults may remain conservative (`openrouter`); production
 * selects `azure-mai` explicitly.
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

  if (config.primaryProvider === "sarvam") {
    if (!config.sarvam?.apiKey) {
      throw new Error(
        'TRANSCRIPTION_PRIMARY_PROVIDER is "sarvam" but SARVAM_API_KEY is missing. Refusing silent OpenRouter fallback.',
      );
    }
    return new SarvamTranscriptionProvider(
      config.sarvam.apiKey,
      config.sarvam.model,
      config.sarvam.mode,
    );
  }

  if (config.primaryProvider === "openrouter") {
    if (!config.openRouter?.apiKey) {
      throw new Error(
        'TRANSCRIPTION_PRIMARY_PROVIDER is "openrouter" but OPENROUTER_API_KEY is missing.',
      );
    }
    return new OpenRouterTranscriptionProvider(
      config.openRouter.apiKey,
      config.openRouter.model,
    );
  }

  if (config.primaryProvider !== undefined) {
    throw new Error(
      `Unknown TRANSCRIPTION_PRIMARY_PROVIDER "${String(config.primaryProvider)}". Expected azure-mai | sarvam | openrouter.`,
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

  if (config.sarvam?.apiKey) {
    return new SarvamTranscriptionProvider(
      config.sarvam.apiKey,
      config.sarvam.model,
      config.sarvam.mode,
    );
  }

  throw new Error(
    "No valid transcription provider could be constructed from configuration.",
  );
}
