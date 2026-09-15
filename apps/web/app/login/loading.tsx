import Image from "next/image";
import Link from "next/link";

export default function Loading() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] to-[#1E1E1E] px-4 sm:px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6 sm:mb-8">
          <Link
            href="/"
            className="inline-flex items-center justify-center mb-4 sm:mb-6 hover:opacity-80 transition-opacity"
          >
            <div className="p-2.5 rounded-2xl bg-white shadow-xl">
              <Image
                src="/logo_Applywizz.png"
                alt="Apply Wizz"
                width={160}
                height={42}
                className="h-9 w-auto object-contain"
                priority
              />
            </div>
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
            Loading...
          </h1>
        </div>
      </div>
    </main>
  );
}
