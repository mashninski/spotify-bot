// Выпадковы кароткі ідэнтыфікатар (старонкі, запісу дыягностыкі). Не для бяспекі.

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
