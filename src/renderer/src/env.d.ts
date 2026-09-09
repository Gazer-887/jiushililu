/// <reference types="vite/client" />
import type { ApiBridge } from '@shared/ipc'

declare global {
  interface Window {
    api: ApiBridge
  }
}

export {}
