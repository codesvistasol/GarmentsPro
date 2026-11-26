import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { recordMovement } from '../src/warehouse.js';
const db = new PrismaClient();
async function main() {
 const names=['T-Shirts','Shirts','Jeans','Hoodies','Trousers'];
 for (const name of names) await db.category.upsert({where:{name},update:{},create:{name}});
 const samples=[['TS-001','Cotton Crewneck T-Shirt','T-Shirts','Black','M',900,1499,120],['JN-014','Slim Fit Denim Jeans','Jeans','Blue','32',2200,3299,64],['HD-007','Fleece Zip Hoodie','Hoodies','Charcoal','L',1800,2899,12],['SH-021','Formal Oxford Shirt','Shirts','White','M',1500,2499,18],['TR-009','Chino Trousers','Trousers','Beige','34',1700,2799,40]] as const;
 for(const [sku,name,cat,color,size,cost,sale,qty] of samples) {
  const c=await db.category.findUniqueOrThrow({where:{name:cat}});
  const p=await db.product.upsert({where:{sku},update:{},create:{sku,name,categoryId:c.id,costPrice:cost,salePrice:sale}});
  const variantSku = `${sku}-${size}-${color}`;
  await db.$transaction(async tx => {
    const inserted = await tx.variant.createMany({
      data: { sku: variantSku, productId: p.id, size, color },
      skipDuplicates: true,
    });
    if (inserted.count && qty) {
      const variant = await tx.variant.findUniqueOrThrow({ where: { sku: variantSku } });
      await recordMovement(tx, { variantId: variant.id, type: 'OPENING', quantity: qty, reason: 'Seed opening balance' });
    }
  });
 }
}
main().finally(()=>db.$disconnect());
