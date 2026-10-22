import { expect, test } from '@playwright/test';

test('physics uses the wire graph and reports reference values', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="physics"]').click();
  await expect(page.locator('#physics-results')).toContainText('40');
  await expect(page.locator('#voltage-chart')).toContainText('4 V');
  await expect(page.locator('#voltage-chart')).toContainText('8 V');
  await expect(page.locator('#circuit-svg [data-wire]')).toHaveCount(3);
});

test('user-provided component names are rendered as text, not HTML', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="physics"]').click();
  await page.locator('[data-comp="r1"]').click();
  await page.locator('#prop-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#apply-props').click();
  await expect(page.locator('#component-inspector')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#component-inspector img')).toHaveCount(0);
});

test('unknown resistance is inferred from entered measurements, not the stored resistor value', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="physics"]').click();
  await page.locator('[data-comp="r1"]').click();
  await page.locator('#unknown-kind').selectOption('resistance');
  await page.locator('#unknown-measured-v').fill('12 V');
  await page.locator('#unknown-measured-i').fill('200 mA');
  await page.locator('#solve-unknown').click();
  await expect(page.locator('#unknown-solution')).toContainText('60 Ω');
  await expect(page.locator('#unknown-solution')).toContainText('لا تستبدل قيمة المقاومة');
});

test('wire tool connects two terminals and recalculates the circuit', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="physics"]').click();
  await page.locator('#wire-tool').click();
  await page.locator('[data-terminal="r1:a"]').click();
  await page.locator('[data-terminal="r2:b"]').click();
  await expect(page.locator('#circuit-svg [data-wire]')).toHaveCount(4);
  await expect(page.locator('#physics-results')).toContainText('لا توجد نتائج عددية');
});

test('chemistry derives total volume from additions and does not draw unsupported bubbles', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="chemistry"]').click();
  await page.locator('[data-add-chem="hcl"]').click();
  await page.locator('#chem-add-quantity').fill('25');
  await page.locator('#confirm-chem-add').click();
  await page.locator('[data-add-chem="naoh"]').click();
  await page.locator('#chem-add-quantity').fill('25');
  await page.locator('#confirm-chem-add').click();
  await page.locator('[data-chem-volume="0"]').fill('25');
  await page.locator('[data-chem-volume="0"]').press('Tab');
  await page.locator('[data-chem-volume="1"]').fill('25');
  await page.locator('[data-chem-volume="1"]').press('Tab');
  await expect(page.locator('#chem-volume')).toHaveValue('50');
  await page.locator('#run-reaction').click();
  await expect(page.locator('#reaction-result')).toContainText('7');
  await expect(page.locator('#bubbles circle')).toHaveCount(0);
});

test('unsupported mixtures are labeled outside scope, not as non-reactive', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="chemistry"]').click();
  await page.locator('[data-add-chem="hcl"]').click();
  await page.locator('#confirm-chem-add').click();
  await page.locator('[data-add-chem="nacl"]').click();
  await page.locator('#confirm-chem-add').click();
  await page.locator('#run-reaction').click();
  await expect(page.locator('#reaction-result')).toContainText('خارج نطاق المحاكاة');
  await expect(page.locator('#reaction-result')).not.toContainText('لا تتفاعل');
});

test('local experiment save, open, export and delete flow works', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="physics"]').click();
  await page.locator('#physics-save').click();
  await page.locator('#experiment-name').fill('اختبار حفظ');
  await page.locator('#experiment-notes').fill('تجربة تلقائية');
  await page.locator('#confirm-save').click();
  await page.locator('[data-view="saved"]').click();
  await expect(page.locator('#saved-list')).toContainText('اختبار حفظ');
  await page.locator('[data-open-exp]').first().click();
  await expect(page.locator('#view-physics')).toHaveClass(/active/);
  await page.locator('[data-view="saved"]').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-export-exp]').first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.json');
  page.once('dialog', (dialog: { accept(): Promise<void> }) => dialog.accept());
  await page.locator('[data-delete-exp]').first().click();
  await expect(page.locator('#saved-list')).toContainText('لا توجد تجارب مطابقة');
});

test('invalid project import is rejected with a clear message', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-view="saved"]').click();
  await page.locator('#import-project-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"tayf-project","schemaVersion":99,"experiments":[]}') });
  await expect(page.locator('#toast')).toContainText('ملف المشروع غير صالح');
});
