import type { ProviderReconciliationContract } from "./providerContract.js";
import { sideEffectCapabilityRegistry } from "../canonicalSemantics.js";

class ReconciliationRegistry {
  private readonly contracts = new Map<string, ProviderReconciliationContract>();

  register(toolName: string, contract: ProviderReconciliationContract): void {
    this.contracts.set(toolName, contract);
    if (contract.getCapability) {
      const cap = contract.getCapability();
      sideEffectCapabilityRegistry.register(toolName, cap);
    }
  }

  get(toolName: string): ProviderReconciliationContract | undefined {
    return this.contracts.get(toolName);
  }

  clear(): void {
    this.contracts.clear();
    sideEffectCapabilityRegistry.clear();
  }
}

export const reconciliationRegistry = new ReconciliationRegistry();
