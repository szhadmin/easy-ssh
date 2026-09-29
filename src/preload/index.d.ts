import type { EasySshApi } from '@shared/api'

declare global {
  interface Window {
    api: EasySshApi
  }
}

export {}
