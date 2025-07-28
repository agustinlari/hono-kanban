export function esFechaValida(fecha: any): fecha is string {
  if (typeof fecha !== 'string') return false;
  // Intenta parsear, si es inválido, Date.parse devuelve NaN
  return !isNaN(Date.parse(fecha));
}