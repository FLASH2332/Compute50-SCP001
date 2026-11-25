/**
 * Demo agent — public API.
 *
 *   const agent = createDemoAgent({ services: { ...servicesFromEnv(), approver } });
 *   await agent.make({ map: someMapSource, goal: 'invite a member', seconds: 45 });
 *
 * The agent depends only on core/ (AppMap + ports). Graph sources plug in
 * through adapters/, models and people through providers/ or your own port
 * implementations.
 */
export { AppMap, urlTemplate, stateIdOf } from './core/appMap.js';
export type { AppMapData, AppPage, Control, UiState, ActionEdge, Risk } from './core/appMap.js';
export type { Approver, BrowserHooks, Logger, MapSource, Services, Speech, SpeechClip, TextModel, VisionModel } from './core/ports.js';
export { DemoAgent, createDemoAgent, type AgentConfig, type MakeInput, type MakeResult } from './run/agent.js';
export { editDemo, undoDemo, listVersions } from './run/edit.js';
export { AutoApprover, CliApprover } from './providers/approvers.js';
export { ElevenLabsSpeech, SilentSpeech, speechFromEnv } from './providers/speech.js';
export { GroqText, GroqVision, groqFromEnv } from './providers/groq.js';
export type { Finding } from './media/check.js';
export { OnboardingAgent, createOnboardingAgent, type AskInput, type AskResult, type OnboardingConfig } from './onboard/agent.js';
export { NOT_FOUND } from './onboard/understand.js';

import type { Services } from './core/ports.js';
import { groqFromEnv } from './providers/groq.js';
import { speechFromEnv } from './providers/speech.js';

/** Default providers from environment variables (Groq, ElevenLabs); missing keys → offline fallbacks. */
export function servicesFromEnv(env = process.env): Partial<Services> {
  return { ...groqFromEnv(env), speech: speechFromEnv(env) };
}
