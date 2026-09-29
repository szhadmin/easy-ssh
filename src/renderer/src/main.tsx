import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { applyCompletion, planCompletion, splitPathToken, tokenizeLine } from './lib/complete'
import './styles.css'

// 冒烟自检入口：仅当以 ?smoke=1 打开时才挂出来（见 main/index.ts 的 loadFile）。
// 正常启动不会暴露任何调试句柄。
if (new URLSearchParams(window.location.search).has('smoke')) {
  ;(window as unknown as Record<string, unknown>)['__easyssh'] = {
    store: useStore,
    // 补全引擎是纯函数，挂出来就能在冒烟脚本里「用真实远端数据跑一遍」，
    // 验证 cd 补全 → 继续往下钻、docker 容器名补全这些整条链路。
    complete: { planCompletion, applyCompletion, splitPathToken, tokenizeLine }
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
