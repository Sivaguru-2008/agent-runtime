/**
 * Onboarding + discovery layer — public surface.
 *
 * Sits on top of the explainability registry: a first-run guided tour, a
 * ⌘K concept glossary, and the launchers that trigger them. Mount the providers
 * once at the app root (TourProvider, GlossaryProvider) and the overlays beside
 * the ExplainPanel (TourOverlay, ConceptGlossary); drop OnboardingLaunchers in a
 * top bar and TourAutoStart inside each surface.
 */

export { TourProvider, useTour } from "./tour-provider";
export { TourOverlay } from "./tour-overlay";
export { TourAutoStart } from "./tour-auto-start";
export { GlossaryProvider, useGlossary, ConceptGlossary } from "./concept-glossary";
export { OnboardingLaunchers, TakeTheTourButton, GlossaryButton } from "./onboarding-launchers";
