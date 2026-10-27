// Runs in the page's MAIN world at document_start, before the SPA loads.
//
// tenten.art sends datetimes as naive local strings in Beijing time
// ("2026-10-27T12:45:44", no offset) and the SPA parses them with `new Date(str)`,
// which reads them in the *browser's* timezone. Outside UTC+8 every relative time
// is off by hours ("刚刚" for anything that looks like it is in the future).
// Treat offset-less datetime strings as +08:00. Date-only strings and anything with
// an explicit offset or Z are left alone.
(() => {
  const SERVER_OFFSET_MIN = -480; // getTimezoneOffset() value for UTC+8
  if (new Date().getTimezoneOffset() === SERVER_OFFSET_MIN) return;

  const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
  const fix = (v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    return NAIVE.test(s) ? `${s.replace(' ', 'T')}+08:00` : v;
  };

  const NativeDate = Date;
  function TentenDate(...args) {
    if (!new.target) return NativeDate();
    if (args.length === 1) args[0] = fix(args[0]);
    return Reflect.construct(NativeDate, args, new.target);
  }
  Object.setPrototypeOf(TentenDate, NativeDate); // Date.now, Date.UTC
  TentenDate.prototype = NativeDate.prototype; // instanceof Date keeps working
  TentenDate.parse = (s) => NativeDate.parse(fix(s));
  TentenDate.toString = () => NativeDate.toString();
  window.Date = TentenDate;
})();
