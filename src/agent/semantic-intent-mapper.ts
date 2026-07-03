import type {
  DraftServiceQuery,
  SemanticInfrastructureIntent,
  SemanticIntentService,
  ValidatedQuery,
} from '../domain/types.js';
import { validateValidatedQuery } from '../domain/schemas.js';
import {
  getTrustedDefaultImageForBase,
  isTrustedImageReference,
  resolveImageReference,
} from '../domain/supported-images.js';

export interface SemanticIntentMappingResult {
  query: ValidatedQuery | null;
  diagnostics: string[];
}

const MIN_SEMANTIC_CONFIDENCE = 0.55;

export function mapSemanticIntentToValidatedQuery(
  baseQuery: ValidatedQuery,
  intent: SemanticInfrastructureIntent,
): SemanticIntentMappingResult {
  const diagnostics: string[] = [];

  if (intent.requiresUserInput) {
    return {
      query: null,
      diagnostics: ['Semantic intent requires user input; keeping existing parser output.'],
    };
  }

  if (intent.confidence < MIN_SEMANTIC_CONFIDENCE) {
    return {
      query: null,
      diagnostics: [`Semantic intent confidence ${intent.confidence} is below ${MIN_SEMANTIC_CONFIDENCE}; keeping existing parser output.`],
    };
  }

  if (intent.ambiguities.length > 0) {
    return {
      query: null,
      diagnostics: [`Semantic intent has unresolved ambiguities: ${intent.ambiguities.join('; ')}`],
    };
  }

  const services: DraftServiceQuery[] = [];
  for (const service of intent.services) {
    const mapped = mapSemanticService(service, diagnostics);
    if (mapped === null) {
      return { query: null, diagnostics };
    }
    services.push(mapped);
  }

  applySemanticRelationships(services, intent, diagnostics);

  if (services.length === 0) {
    return {
      query: null,
      diagnostics: ['Semantic intent did not produce any deployable service; keeping existing parser output.'],
    };
  }

  return {
    query: validateValidatedQuery({
      ...baseQuery,
      draft: {
        ...baseQuery.draft,
        projectName: intent.projectHint ?? baseQuery.draft.projectName ?? null,
        services,
        missingInformation: [...baseQuery.draft.missingInformation],
      },
      clarificationRequired: false,
      clarificationQuestion: null,
    }),
    diagnostics,
  };
}

function mapSemanticService(
  service: SemanticIntentService,
  diagnostics: string[],
): DraftServiceQuery | null {
  if (service.confidence < MIN_SEMANTIC_CONFIDENCE) {
    diagnostics.push(`Semantic service "${service.id}" confidence ${service.confidence} is below ${MIN_SEMANTIC_CONFIDENCE}.`);
    return null;
  }

  if (service.ambiguities.length > 0) {
    diagnostics.push(`Semantic service "${service.id}" has ambiguities: ${service.ambiguities.join('; ')}`);
    return null;
  }

  const imageInput = service.imageHint ?? service.technology;
  if (imageInput === null) {
    diagnostics.push(`Semantic service "${service.id}" did not include a technology or image hint.`);
    return null;
  }

  const image = resolveTrustedDefaultImage(imageInput);
  if (image === null) {
    diagnostics.push(`Semantic service "${service.id}" image hint "${imageInput}" could not be mapped to the trusted image whitelist.`);
    return null;
  }

  const firstPort = service.ports[0];
  const port = firstPort?.host ?? firstPort?.container ?? null;

  return {
    name: service.id,
    image,
    port,
    replicas: service.replicas,
    dependsOn: [...service.dependsOn],
    requestedMounts: [...service.volumeHints],
    privileged: null,
    networkMode: null,
    pidMode: null,
    ipcMode: null,
    cpu: null,
    memoryGb: null,
  };
}

function resolveTrustedDefaultImage(imageInput: string): string | null {
  if (isTrustedImageReference(imageInput)) {
    const resolved = resolveImageReference(imageInput).resolved ?? imageInput;
    const base = resolved.split(':')[0]?.split('/').pop() ?? resolved;
    return getTrustedDefaultImageForBase(base) ?? resolved;
  }

  const resolution = resolveImageReference(imageInput);
  const canonical = resolution.resolved ?? resolution.candidates[0] ?? null;
  if (canonical === null) return null;
  return getTrustedDefaultImageForBase(canonical);
}

function applySemanticRelationships(
  services: DraftServiceQuery[],
  intent: SemanticInfrastructureIntent,
  diagnostics: string[],
): void {
  const serviceNames = new Set(services.map((service) => service.name).filter((name): name is string => name !== null));

  for (const relationship of intent.relationships) {
    if (!serviceNames.has(relationship.from) || !serviceNames.has(relationship.to)) {
      diagnostics.push(`Semantic relationship ${relationship.from} -> ${relationship.to} references an unknown service and was ignored.`);
      continue;
    }

    const dependentName = relationship.from;
    const dependencyName = relationship.to;
    const dependent = services.find((service) => service.name === dependentName);
    if (!dependent) continue;

    dependent.dependsOn = [...new Set([...(dependent.dependsOn ?? []), dependencyName])];
  }
}
