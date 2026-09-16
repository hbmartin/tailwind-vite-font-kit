import { AsyncLocalStorage } from 'node:async_hooks'

const doctorContext = new AsyncLocalStorage()

export const isDoctorContext = () => doctorContext.getStore() === true

export const runInDoctorContext = (fn) => doctorContext.run(true, fn)
