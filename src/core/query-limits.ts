// Representation bound of compile_query's unsigned 32-bit hours argument.
// Dataset coverage is independent: the compiler intersects the requested window
// with the actual dataset bounds without changing the requested intent.
export const MAX_WINDOW_HOURS = 0xffff_ffff;
