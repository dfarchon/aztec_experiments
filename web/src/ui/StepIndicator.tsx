import { Icon } from "./Icon";

export function StepIndicator({
  steps,
  currentStep,
  label,
}: {
  steps: readonly string[];
  currentStep: number;
  label: string;
}) {
  return (
    <ol className="step-indicator" aria-label={label}>
      {steps.map((step, index) => {
        const completed = index + 1 < currentStep;
        const current = index + 1 === currentStep;
        return (
          <li
            key={step}
            className={completed ? "is-complete" : current ? "is-current" : ""}
            aria-current={current ? "step" : undefined}
          >
            <span className="step-indicator-node" aria-hidden="true">
              {completed ? (
                <Icon name="check" />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <span className="step-indicator-label">{step}</span>
            <span className="sr-only">
              {completed
                ? "Completed"
                : current
                  ? "Current step"
                  : "Not started"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
