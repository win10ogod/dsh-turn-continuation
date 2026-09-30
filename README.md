# dsh-turn-continuation

DSH 在模型回報 `max-tokens`（單次輸出 token 上限），或待辦尚未完成卻回傳正常 `stop` 時，自動在**同一個回合**接續任務。支援並測試於 DeepSeek Harness `0.1.7-rc.2` 與 `0.2.0-rc.2`。

插件監聽已提交的模型回應，在 `agent/turn-stopping` 階段用 `agent.steer()` 排入下一步。會話、回合編號、已生成文字、工具結果與工作區均延續使用。每次接續是新的模型請求，會產生相應用量；原有模型、每次請求的 `maxTokens`、工具權限和上下文管理設定保持原值。

正常完成且沒有未完成待辦的回應不會自動重開。插件讀取本回合真實提交的 `todo/write` 清單；存在 `pending` 或 `in_progress` 項目時，會要求繼續具體操作並驗證成果，不能只承諾下一步。清單完成後允許模型交付並結束回合。

使用者停止、工具明確結束回合，以及模型請求錯誤均交回 DSH 原有處理。若缺少必要資訊或外部條件使任務無法繼續，模型可使用 `continuation_yield` 記錄具體原因，再向使用者說明，避免帶著未完成待辦無限重試。DSH 核心會把截斷回應中的工具呼叫排除，插件請模型在需要時重新產生完整呼叫，不執行半截參數。

## 安裝與設定

透過 DSH 插件管理器安裝本套件，或在 profile 的 `dsh.profile.bundles` 加入 `dsh-turn-continuation` 並安裝對應依賴。套件包含 `cordis.patch.yml`，安裝後重新載入 profile。

```yaml
- id: turn-continuation
  name: dsh-turn-continuation
  config:
    enabled: true
    continueIncompleteTodos: true
    maxContinuations: 0
```

`maxContinuations: 0` 表示不另設接續次數上限；正整數表示每回合最多自動恢復多少次輸出截斷或未完成待辦的提前停止。此數字不計入截斷後正常工具結果的接續步驟。`continueIncompleteTodos: false` 只關閉待辦判斷，保留輸出上限接續；`enabled: false` 停用整個插件。

## 驗證與邊界

```text
pnpm install --frozen-lockfile
pnpm check
```

整合測試直接掛載真實 DSH Agent loop、會話、待辦與工具服務，使用可控的模型 adapter 重現上限與提前停止。涵蓋未裝插件時停止、同回合接續工具到最後答覆、連續截斷、截斷工具參數、手動停止、工具結束回合、既有使用者引導、停用、指定次數限制、請求錯誤、空白答覆及帶未完成待辦的進度敘述。

沒有本回合待辦時，正常 `stop` 不會被猜測成任務未完成。待辦狀態也不能代替成果驗證，模型仍可能判斷錯誤；插件不能保證任意模型、任意任務都成功。上下文超限、服務端配額或網路故障不會被當成輸出截斷。可搭配 `dsh-auto-tool-prune` 自動縮短過大工具結果。

DSH `0.1.7-rc.2` 與 `0.2.0-rc.2` 會在回合內記住曾發生的 `max-tokens`，即使後續接續成功，最終 `turn/end` 仍可能保留此原因，介面因而仍可能顯示上限標記。插件不改寫這項核心紀錄；同回合中的後續步驟已完成，並非在第一次上限處停止。

接續訊息使用插件自己的 `source.kind: turn-continuation`，符合 format v4 的來源要求，不冒充真人輸入。
