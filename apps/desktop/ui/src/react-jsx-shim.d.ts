/**
 * React 19 moved the JSX namespace under `React.JSX` and dropped the global
 * `JSX` namespace. This codebase annotates component return types as
 * `JSX.Element`; re-expose that one member globally so the migration is a
 * single shim rather than an edit to every component file.
 */
import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
  }
}
