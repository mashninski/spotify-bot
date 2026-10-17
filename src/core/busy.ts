// Справы, якія нельга перарываць перазагрузкай старонкі (аўтаабнаўленне, src/ui/shared/update.ts).
// Галоўнае — абнаўленне ўваходу ў Twitch і Spotify: refresh token аднаразовы, і калі старонка перазагрузіцца,
// пакуль ідзе запыт, стары ключ ужо згарэў, а новы не захаваны — уваход прападае.

let count = 0;

/** Выканаць справу, пакуль яна ідзе — старонка не перазагружаецца сама. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  count++;
  try {
    return await work();
  } finally {
    count--;
  }
}

/** Ці ідзе зараз справа, якую нельга перарываць. */
export const busy = () => count > 0;
