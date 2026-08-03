import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { OperatorAccessControls } from "@/components/operator-access-controls"

describe("OperatorAccessControls", () => {
  it("keeps typing local and exposes an explicit save-and-retry action", () => {
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
    expect(onRetry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Save token and retry operator authentication" }))

    expect(onTokenChange).toHaveBeenCalledWith("pilot-token")
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
