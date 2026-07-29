import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  OPERATOR_AUTH_CHANGED_EVENT,
  OPERATOR_TOKEN_STORAGE_KEY,
  operatorToken,
  storeOperatorToken,
} from "../operator-auth"

describe("operator auth state", () => {
  beforeEach(() => window.localStorage.clear())

  it("stores the token and announces protected-resource refresh", () => {
    const changed = vi.fn()
    window.addEventListener(OPERATOR_AUTH_CHANGED_EVENT, changed)

    storeOperatorToken("pilot-token")

    expect(operatorToken()).toBe("pilot-token")
    expect(changed).toHaveBeenCalledOnce()
    window.removeEventListener(OPERATOR_AUTH_CHANGED_EVENT, changed)
  })

  it("removes an empty token and announces the change", () => {
    window.localStorage.setItem(OPERATOR_TOKEN_STORAGE_KEY, "old-token")
    const changed = vi.fn()
    window.addEventListener(OPERATOR_AUTH_CHANGED_EVENT, changed)

    storeOperatorToken("")

    expect(operatorToken()).toBeUndefined()
    expect(changed).toHaveBeenCalledOnce()
    window.removeEventListener(OPERATOR_AUTH_CHANGED_EVENT, changed)
  })
})
