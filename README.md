# Bhuleshwar purchase workflow

This is a scoped working copy for the purchase-document workflow.

Included:

- Purchase document upload and AI extraction
- Purchase order, invoice, e-way bill, lorry receipt, weighment, and supporting-document comparison
- Mismatch review and case approval
- Tally company connection and company linking
- Tally purchase-master loading and mapping
- Tally Purchase voucher preparation, approval, queueing, creation, and verification
- Authentication, team access, storage, and shared case infrastructure required by the workflow

Excluded from the application surface:

- Bank statement reconciliation and bank voucher posting
- Cash deposits
- Cash discounts and debit notes
- Payment collections and follow-up reminders
- WhatsApp collection messages
- Local-agent document and bank-processing screens

The original repository remains outside this folder and has not been changed.

The Tally bridge is still shared infrastructure. Its large bridge runtime contains historical command handlers for multiple workflows; those handlers need a later focused extraction if the connector itself must be reduced to purchase-only behavior.

## 🚀 Features

- **Next.js 15** - Latest version with App Router
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first CSS framework
- **Shadcn UI** - Beautiful, accessible component library
- **ESLint** - Code quality and consistency

## 📦 Installed Components

- Button
- Card
- Input

## 🛠️ Getting Started

### Development Server

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the result.

### Building for Production

```bash
npm run build
npm start
```

## 📚 Adding More Shadcn Components

To add more Shadcn UI components:

```bash
npx shadcn@latest add [component-name]
```

For example:
```bash
npx shadcn@latest add dialog
npx shadcn@latest add dropdown-menu
npx shadcn@latest add form
```

Browse all available components at [ui.shadcn.com](https://ui.shadcn.com)

## 📖 Documentation

- [Next.js Documentation](https://nextjs.org/docs)
- [Shadcn UI Documentation](https://ui.shadcn.com)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [TypeScript Documentation](https://www.typescriptlang.org/docs)

## 📁 Project Structure

```
AutoDealer/
├── src/
│   ├── app/
│   │   ├── layout.tsx      # Root layout
│   │   ├── page.tsx        # Home page
│   │   └── globals.css     # Global styles
│   ├── components/
│   │   └── ui/             # Shadcn UI components
│   └── lib/
│       └── utils.ts        # Utility functions
├── public/                 # Static assets
└── package.json           # Dependencies
```

## 🎨 Customization

### Theme Colors

Edit the CSS variables in `src/app/globals.css` to customize your theme colors.

### Tailwind Configuration

Modify `tailwind.config.ts` for custom Tailwind settings.

### Component Configuration

Check `components.json` for Shadcn UI configuration.

## 📝 License

This project is open source and available under the MIT License.
