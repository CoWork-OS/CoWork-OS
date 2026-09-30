import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueueSettingsLoadFailure, QueueSettingsSaveFeedback } from "../QueueSettings";

describe("QueueSettings load errors", () => {
  it("renders a visible retryable error instead of queue defaults when the host read fails", () => {
    const markup = renderToStaticMarkup(
      React.createElement(QueueSettingsLoadFailure, {
        message: "Queue settings could not be read.",
        onRetry: () => {},
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load queue settings: Queue settings could not be read.");
    expect(markup).toContain(">Retry</button>");
  });

  it("renders save failures as an alert and only shows saved state after confirmation", () => {
    const failure = renderToStaticMarkup(
      React.createElement(QueueSettingsSaveFeedback, {
        error: "The host could not save these values.",
        saved: false,
      }),
    );
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("The host could not save these values.");

    const success = renderToStaticMarkup(
      React.createElement(QueueSettingsSaveFeedback, { error: null, saved: true }),
    );
    expect(success).toContain('role="status"');
    expect(success).toContain("Queue settings saved.");
  });
});
