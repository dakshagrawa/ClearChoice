const app = document.querySelector<HTMLElement>('#app');

if (!app) {
  throw new Error('ClearChoice popup root is missing.');
}

app.textContent = 'ClearChoice';
