import PDFDocument from 'pdfkit';
import type { Prisma, SalesPayment } from '@prisma/client';
import { cents, decimal } from './sales-money.js';

type Invoice = Prisma.SalesDispatchGetPayload<{
  include: { order: true; lines: { include: { item: true } } };
}>;

export function invoiceLogo(value: unknown) {
  if (typeof value !== 'string' || value.length > 81000) return;
  const encoded = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)?.[1];
  if (!encoded) return;
  const image = Buffer.from(encoded, 'base64');
  if (image[0] !== 255 || image[1] !== 216 || image.at(-2) !== 255 || image.at(-1) !== 217 ||
      image.toString('base64') !== encoded) return;
  // Confirm the same PDFKit decoder used to print the logo accepts it.
  try {
    const probe = new PDFDocument({ autoFirstPage: false });
    probe.resume();
    try { probe.addPage().image(image, 0, 0, { fit: [1, 1] }); } finally { probe.end(); }
    return image;
  } catch { return; }
}

const exchangePolicy = 'Purchased items are non-refundable and cannot be returned. Exchanges only.';

export async function invoicePdf(invoice: Invoice, checkoutPayment?: Pick<SalesPayment, 'amount' | 'method'> | null): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margin: 42, info: { Title: 'Sales invoice ' + invoice.reference } });
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdf.on('data', chunk => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  const order = invoice.order;
  const issuer = invoice.issuer && typeof invoice.issuer === 'object' && !Array.isArray(invoice.issuer) ? invoice.issuer : {};
  const logo = invoiceLogo(issuer.invoiceLogo);
  const placement = issuer.invoiceLogoPlacement ?? 'HEADER';
  function drawWatermark() {
    if (!logo || (placement !== 'WATERMARK' && placement !== 'BOTH')) return;
    const { x, y, page } = pdf;
    pdf.save().opacity(0.09).image(logo, (page.width - 310) / 2, (page.height - 310) / 2, {
      fit: [310, 310], align: 'center', valign: 'center',
    }).restore();
    pdf.x = x;
    pdf.y = y;
  }
  drawWatermark();
  pdf.on('pageAdded', drawWatermark);
  if (logo && placement !== 'WATERMARK') {
    pdf.image(logo, 42, 42, { fit: [103, 50], valign: 'center' });
    pdf.x = 42;
    pdf.y = 104;
  }
  pdf.fillColor('#173d34').font('Helvetica-Bold').fontSize(24).text(typeof issuer.companyName === 'string' ? issuer.companyName : 'GarmentPro');
  pdf.fontSize(14).text('Sales invoice').moveDown(0.35);
  pdf.fillColor('#365548').font('Helvetica').fontSize(10).text(invoice.reference);
  const issued = new Intl.DateTimeFormat('en-GB', {
    timeZone: typeof issuer.invoiceTimeZone === 'string' ? issuer.invoiceTimeZone : 'Asia/Karachi',
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
  }).format(invoice.createdAt);
  pdf.text('Issued: ' + issued);
  for (const field of [issuer.address, issuer.phone, issuer.email]) if (typeof field === 'string' && field) pdf.text(field);
  pdf.moveDown(0.5).fillColor('#19372e');
  if (order.number !== invoice.reference) pdf.text('Sales order ' + order.number);
  pdf.text('Due ' + order.dueDate.toISOString().slice(0, 10));
  pdf.moveDown().font('Helvetica-Bold').text(order.customerName).font('Helvetica');
  for (const field of [order.customerContact, order.customerEmail, order.customerPhone, order.customerAddress]) {
    if (field) pdf.text(field);
  }
  pdf.text('Sale / dispatch location: ' + invoice.destination).moveDown();

  const widths = [191, 42, 88, 90, 100];
  const labels = ['Product and variant', 'Qty', 'Unit (PKR)', 'Discount', 'Amount (PKR)'];
  const start = 42;
  const positions = widths.map((_, index) => start + widths.slice(0, index).reduce((sum, width) => sum + width, 0));
  const bottom = pdf.page.height - pdf.page.margins.bottom;
  function row(values: string[], bold = false) {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    const height = Math.max(...values.map((value, index) => pdf.heightOfString(value, { width: widths[index] - 12 }))) + 10;
    const y = pdf.y;
    if (bold) pdf.rect(start, y, 511, height).fill('#e7f0df');
    pdf.fillColor('#19372e');
    values.forEach((value, index) => {
      pdf.text(value, positions[index] + 4, y + 4, { width: widths[index] - 12, align: index ? 'right' : 'left' });
    });
    pdf.moveTo(start, y + height).lineTo(start + 511, y + height).strokeColor('#dfe5ef').stroke();
    pdf.x = start;
    pdf.y = y + height;
  }
  row(labels, true);
  for (const line of invoice.lines) {
    const item = line.item;
    const details = [item.productName, item.variantSku + ' | ' + item.color + ' / ' + item.size].join('\n');
    pdf.font('Helvetica').fontSize(10);
    if (pdf.y + pdf.heightOfString(details, { width: widths[0] - 12 }) + 25 > bottom) {
      pdf.addPage();
      row(labels, true);
    }
    const discount = cents(item.unitPrice) * BigInt(line.quantity) - cents(line.amount);
    row([details, String(line.quantity), item.unitPrice.toFixed(2), decimal(discount), line.amount.toFixed(2)]);
  }
  if (pdf.y + (checkoutPayment ? 95 : 35) > bottom) pdf.addPage();
  pdf.moveDown();
  row(['Invoice total (PKR)', '', '', '', invoice.total.toFixed(2)], true);
  if (checkoutPayment) {
    const method = checkoutPayment.method === 'CASH' ? 'Cash' : 'Bank transfer';
    row(['Payment recorded (' + method + ')', '', '', '', checkoutPayment.amount.toFixed(2)]);
    row(['Balance at issue (PKR)', '', '', '', decimal(cents(invoice.total) - cents(checkoutPayment.amount))]);
  }
  const footer = typeof issuer.invoiceFooter === 'string' ? issuer.invoiceFooter : '';
  pdf.font('Helvetica').fontSize(10);
  const footerHeight = footer ? pdf.heightOfString(footer) + 12 : 0;
  pdf.font('Helvetica-Bold');
  if (pdf.y + footerHeight + pdf.heightOfString(exchangePolicy) + 12 > bottom) pdf.addPage();
  if (footer) pdf.font('Helvetica').moveDown().text(footer);
  pdf.moveDown(0.85).font('Helvetica-Bold').fontSize(10).fillColor('#173d34').text(exchangePolicy);
  pdf.end();
  return result;
}
