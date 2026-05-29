# Replay Lifecycle Diagrams

This document contains Mermaid diagrams illustrating the step-by-step decision logic, safety checks, and state transitions of the replay-equivalent execution engine and sandbox isolation.

---

## 0. Replay Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> REPLAY_PENDING: parentExecutionId set
    REPLAY_PENDING --> REPLAYING: beginReplay()
    REPLAYING --> REPLAY_EQUIVALENT: step matches parent
    REPLAY_EQUIVALENT --> REPLAY_VERIFIED: all steps matched
    REPLAYING --> REPLAY_DIVERGED: mismatch / stale log
    REPLAY_EQUIVALENT --> REPLAY_DIVERGED: mismatch
    REPLAY_DIVERGED --> REPLAY_UNSAFE: blocked live side effect
    REPLAYING --> REPLAY_ABORTED: abort / fence loss
    REPLAY_DIVERGED --> REPLAY_ABORTED: failure
    REPLAY_UNSAFE --> REPLAY_ABORTED
    REPLAY_VERIFIED --> [*]
    REPLAY_ABORTED --> [*]
```

---

## 1. Replay Interception and Divergence Logic

The following diagram outlines the decision flow inside `runStep` and `runToolStep` when an execution carries a `parentExecutionId`.

```mermaid
graph TD
    A[Start execution step] --> B{Is parentExecutionId set?}
    B -- No --> C[Execute live step normally]
    B -- Yes --> D{Is execution already diverged?}
    
    D -- Yes --> E[Execute live step inside Replay Sandbox]
    D -- No --> F{Does expected step event exist in parent log?}
    
    F -- No --> G[Mark diverged: MISSING_STEP]
    F -- Yes --> H{Do step type and input match?}
    
    H -- No --> I[Mark diverged: INPUT_MISMATCH / ORDER_MISMATCH]
    H -- Yes --> J[Replay Persisted Output]
    
    G --> K[Publish REPLAY_DIVERGENCE_DETECTED]
    I --> K
    K --> L[Transition execution status to RUNNING]
    L --> E
    
    J --> M[Freeze Clock: use original timestamps]
    M --> N[Replicate nested step events]
    N --> O[Publish EXECUTION_STEP_COMPLETED]
    O --> P[Return replayed output verbatim]
```

---

## 2. Replay Sandbox Isolation Decision Tree

The following diagram traces how tool executions are gated inside `runToolStep` for a replaying execution.

```mermaid
graph TD
    A[runToolStep invoked] --> B{Is replaying execution?}
    B -- No --> C[Invoke ToolExecutor live]
    
    B -- Yes --> D{Is execution diverged?}
    
    D -- No --> E[Load recorded output from events/dedup]
    E --> F[Publish TOOL_CALLED with replayed output]
    F --> G[Return cached outcome directly]
    
    D -- Yes --> H{Is toolName marked safe / readOnly?}
    
    H -- Yes --> C
    H -- No --> I[Block live side-effect]
    I --> J[Throw ReplaySandboxViolationError]
    J --> K[Gracefully fail execution with status FAILED]
```
