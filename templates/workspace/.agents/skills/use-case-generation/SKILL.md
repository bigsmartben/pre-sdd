---
name: use-case-generation
description: Generate traceable Business Cases and Component Cases from UC, confirmed Mapping, and Lit public contracts.
---

# Use Case Generation

Generate two distinct validation layers:

- Business Case checks a Route → Page → Component → Event → Port → State chain.
- Component Case checks one component's Property, Attribute, Slot, Component State, Event, Motion, and Viewport combinations.

Every case and fact cites UC, Mapping, and Framework sources. Missing facts become `gaps`; never edit UC, Mapping, or Lit code to fill them. The output is neutral validation data that MockCase may consume. It is never imported by `src/ui` or included in UIHTML.
