const beijingLogTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  calendar: "gregory",
  numberingSystem: "latn",
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

/** 日志展示使用东八区，但保留明确偏移量，避免受宿主机时区影响。 */
export function formatBeijingLogTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("日志时间必须是有效日期");
  }

  const parts = Object.fromEntries(
    beijingLogTimeFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}+08:00`;
}

/** Pino timestamp hook 的返回值需要包含字段前导逗号。 */
export function beijingPinoTimestamp(): string {
  return `,"time":"${formatBeijingLogTimestamp(new Date())}"`;
}
