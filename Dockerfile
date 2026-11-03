FROM oven/bun:1

WORKDIR /app

# طبقة التبعيات — تُخزَّن مؤقتاً ما دام القفل ثابتاً
COPY package.json bun.lock ./
RUN bun install --production

# باقي الكود
COPY . .

# ريندر يضبط PORT تلقائياً — الخدمة تستمع عليه (افتراضي 3030)
EXPOSE 3000

CMD ["bun", "index.ts"]
