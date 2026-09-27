# dsh-turn-continuation

DSH 在模型回報 `max-tokens`（單次輸出 token 上限）時，自動在**同一個回合**接續任務。支援並測試於 DeepSeek Harness `0.1.7-rc.2`。

插件監聽已提交的模型回應，在 `agent/turn-stopping` 階段用 `agent.steer()` 排入下一步。會話、回合編號、已生成文字、工具結果與工作區均延續使用。每次接續是新的模型請求，會產生相應用量；原有模型、每次請求的 `maxTokens`、工具權限和上下文管理設定保持原值。

正常完成的回應不會自動重開。使用者停止、工具明確結束回合，以及模型請求錯誤均交回 DSH 原有處理。DSH 核心會把截斷回應中的工具呼叫排除，插件請模型在需要時重新產生完整呼叫，不執行半截參數。

## 安裝與設定

透過 DSH 插件管理器安裝本套件，或在 profile 的 `dsh.profile.bundles` 加入 `dsh-turn-continuation` 並安裝對應依賴。套件包含 `cordis.patch.yml`，安裝後重新載入 profile。

```yaml
- id: turn-continuation
  name: dsh-turn-continuation
  config:
    enabled: true
    maxContinuations: 0
```

`maxContinuations: 0` 表示不另設接續次數上限；正整數表示每回合最多自動接續多少次輸出截斷。此數字不計入截斷後正常工具結果的接續步驟。`enabled: false` 停用插件。

## 驗證與邊界

```text
pnpm install --frozen-lockfile
pnpm check
```

整合測試直接掛載真實 DSH Agent loop、會話與工具服務，使用可控的模型 adapter 重現上限。涵蓋未裝插件時停止、同回合接續工具到最後答覆、連續截斷、截斷工具參數、手動停止、工具結束回合、既有使用者引導、停用、指定次數限制與請求錯誤。

這個插件處理模型明確回報的 `max-tokens`。模型自行回傳正常 `stop`、上下文超限、服務端配額或網路故障不會被當成輸出截斷。

DSH `0.1.7-rc.2` 會在回合內記住曾發生的 `max-tokens`，即使後續接續成功，最終 `turn/end` 仍可能保留此原因，介面因而仍可能顯示上限標記。插件不改寫這項核心紀錄；同回合中的後續步驟已完成，並非在第一次上限處停止。

接續訊息使用插件自己的 `source.kind: turn-continuation`，符合 format v4 的來源要求，不冒充真人輸入。
