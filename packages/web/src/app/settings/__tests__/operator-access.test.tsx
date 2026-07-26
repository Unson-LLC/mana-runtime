import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { OperatorAccessControls } from "../page"

describe("OperatorAccessControls", () => {
  it("labels the token input and exposes a purpose-specific retry action", () => {
    const onTokenChange = vi.fn()
    const onRetry = vi.fn()
    render(
      <OperatorAccessControls
        token=""
        onTokenChange={onTokenChange}
        onRetry={onRetry}
      />,
    )

    const input = screen.getByLabelText("Operator Token")
    fireEvent.change(input, { target: { value: "pilot-token" } })
    fireEvent.click(screen.getByRole("button", { name: "Retry operator authentication" }))

    expect(onTokenChange).toHaveBeenCalledWith("pilot-token")
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
