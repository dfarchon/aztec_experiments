const fullDate = new Intl.DateTimeFormat("en", {
  dateStyle: "full",
  timeStyle: "long",
});

export function formatPostTime(timestamp: number, now: number) {
  const date = new Date(timestamp * 1000);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function PostTime({
  timestamp,
  now,
}: {
  timestamp: number;
  now: number;
}) {
  const date = new Date(timestamp * 1000);
  const label = fullDate.format(date);
  return (
    <time dateTime={date.toISOString()} title={label} aria-label={label}>
      {formatPostTime(timestamp, now)}
    </time>
  );
}
