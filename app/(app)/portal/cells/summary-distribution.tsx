"use client";

/**
 * The distribution bar a column summary draws.
 *
 * Lifted out of live-board.tsx, which is held under a 6,000-line cap by
 * `tests/stage-eight-board-split.test.mjs`. It takes the cell values and the
 * column's options and owns no board state, so it was always a leaf sitting in
 * the wrong file.
 */

import type { Option } from "../board-model";

export function SummaryDistribution({
  values,
  options,
}: {
  values: string[];
  options: Option[];
}) {
  const optionMap = new Map(
    options.map((option) => [
      option.value,
      {
        label: option.label ?? option.value,
        color: option.color,
      },
    ]),
  );
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  const segments = Array.from(counts.entries()).map(([value, count]) => ({
    value,
    count,
    label: optionMap.get(value)?.label ?? value,
    color: optionMap.get(value)?.color ?? "#aeb8be",
  }));
  const filled = segments.reduce((total, segment) => total + segment.count, 0);

  if (!filled) {
    return <span className="sheet-summary-text">0 filled</span>;
  }

  return (
    <div
      className="sheet-summary-distribution"
      title={segments
        .map((segment) => `${segment.label}: ${segment.count}`)
        .join(", ")}
    >
      <span aria-hidden="true">
        {segments.map((segment) => (
          <i
            key={segment.value}
            style={{
              background: segment.color,
              flexGrow: segment.count,
            }}
          />
        ))}
      </span>
      <small>{filled} filled</small>
    </div>
  );
}
