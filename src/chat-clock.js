export function validChatTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 80 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return undefined
  try {
    new Intl.DateTimeFormat('en', {timeZone: zone})
    return zone
  } catch {
    return undefined
  }
}

export function chatClock(state, requestedZone) {
  const zone = validChatTimeZone(requestedZone)
    || validChatTimeZone(state.permanent.companion?.policy?.timeZone)
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC'
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  })
  function stamp(ms) {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map(({type, value}) => [type, value]))
    const offset = parts.timeZoneName.slice(3) || '+00:00'
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
  }
  return {zone, stamp}
}
