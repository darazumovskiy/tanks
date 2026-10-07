// Вид экрана боя ботов — один объект. Отрисовщик берёт отступы поля; страница переносит остальное в CSS-переменные
// (`--watch-*`), поэтому правка вида — правка этого объекта.
// Отступы — в единицах интерфейса холста: CSS-пиксели × масштаб экрана (`Screen.u`). Сверху поле уступает место
// панелям здоровья, таймеру и счёту дуэли.
export interface WatchStyle {
  fieldTopInset: number;
  fieldSideInset: number;
  fieldBottomInset: number;
  barHeightPx: number;
  barWideHeightPx: number;
  transitionMs: number;
  resultMs: number;
  noticeShownMs: number;
}

export const WATCH_STYLE: WatchStyle = {
  fieldTopInset: 62,
  fieldSideInset: 10,
  fieldBottomInset: 6,
  barHeightPx: 56,
  barWideHeightPx: 64,
  transitionMs: 160,
  resultMs: 200,
  noticeShownMs: 4000,
};
