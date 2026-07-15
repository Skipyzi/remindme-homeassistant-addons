declare module "dayjs" {
	function dayjs(date?: any): Dayjs;
	export function extend(plugin: any): void;
	export function isToday(): any;

	export interface Dayjs {
		format(format: string): string;
		add(value: number, unit: string): Dayjs;
		subtract(value: number, unit: string): Dayjs;
		isBefore(date: any, unit?: string): boolean;
		isAfter(date: any, unit?: string): boolean;
		isSame(date: any, unit?: string): boolean;
		diff(date: any, unit?: string): number;
		toDate(): Date;
		toISOString(): string;
		toJSON(): string;
		isValid(): boolean;
		year(): number;
		month(): number;
		date(): number;
		hour(): number;
		minute(): number;
		second(): number;
		millisecond(): number;
		daysInMonth(): number;
		daysInYear(): number;
		daysInWeek(): number;
		daysInQuarter(): number;
		daysInHalfYear(): number;
		get(unit: string): number;
		set(unit: string, value: number): Dayjs;
		startOf(unit: string): Dayjs;
		endOf(unit: string): Dayjs;
		utc(): Dayjs;
		local(): Dayjs;
		clone(): Dayjs;
	}

	export default dayjs;
}
