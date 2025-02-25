/**
 * Type declarations for Bootstrap
 */

declare module 'bootstrap/dist/js/bootstrap.bundle.min.js' {
  export * from 'bootstrap';
}

declare module 'bootstrap' {
  // Add specific Bootstrap types if needed
  export interface Tooltip {
    show(): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
  }

  export interface Modal {
    show(): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
  }

  export interface Dropdown {
    show(): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
  }

  export interface Collapse {
    show(): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
  }

  export interface Toast {
    show(): void;
    hide(): void;
    dispose(): void;
  }
} 