import { AsyncLocalStorage } from 'node:async_hooks'

const doctorContextKey = Symbol.for('tailwind-vite-font-kit.doctor-context')
const doctorContext = (globalThis[doctorContextKey] ??= new AsyncLocalStorage())

export const isDoctorContext = () => doctorContext.getStore() === true

export const runInDoctorContext = (fn) => doctorContext.run(true, fn)
