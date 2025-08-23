// Shadcn UI Toggle Component (ES5/jQuery adaptation)
class Toggle {
    constructor(element, options = {}) {
        this.element = element;
        this.options = {
            pressed: false,
            disabled: false,
            variant: 'default',
            size: 'default',
            onChange: null,
            ...options
        };
        this.init();
    }

    init() {
        this.element.classList.add('toggle');
        this.applyVariant();
        this.applySize();
        
        if (this.options.disabled) {
            this.element.disabled = true;
        }

        // Set initial state
        this.setPressed(this.options.pressed);
        
        // Add event listener
        this.element.addEventListener('click', (e) => {
            if (!this.options.disabled) {
                this.toggle();
            }
        });
    }

    applyVariant() {
        const variants = {
            default: 'toggle-default',
            outline: 'toggle-outline'
        };
        
        const variantClass = variants[this.options.variant] || variants.default;
        this.element.classList.add(variantClass);
    }

    applySize() {
        const sizes = {
            default: 'toggle-default',
            sm: 'toggle-sm',
            lg: 'toggle-lg'
        };
        
        const sizeClass = sizes[this.options.size] || sizes.default;
        this.element.classList.add(sizeClass);
    }

    toggle() {
        this.setPressed(!this.isPressed());
    }

    setPressed(pressed) {
        this.options.pressed = pressed;
        
        if (pressed) {
            this.element.classList.add('toggle-pressed');
            this.element.setAttribute('aria-pressed', 'true');
            this.element.setAttribute('data-state', 'on');
        } else {
            this.element.classList.remove('toggle-pressed');
            this.element.setAttribute('aria-pressed', 'false');
            this.element.setAttribute('data-state', 'off');
        }

        // Call onChange callback if provided
        if (this.options.onChange && typeof this.options.onChange === 'function') {
            this.options.onChange(pressed);
        }

        // Dispatch custom event
        this.element.dispatchEvent(new CustomEvent('toggleChange', {
            detail: { pressed }
        }));
    }

    isPressed() {
        return this.options.pressed;
    }

    setDisabled(disabled) {
        this.options.disabled = disabled;
        this.element.disabled = disabled;
        
        if (disabled) {
            this.element.classList.add('toggle-disabled');
        } else {
            this.element.classList.remove('toggle-disabled');
        }
    }

    static create(selector, options) {
        const elements = document.querySelectorAll(selector);
        const toggles = [];
        elements.forEach(element => {
            const toggle = new Toggle(element, options);
            toggles.push(toggle);
        });
        return toggles.length === 1 ? toggles[0] : toggles;
    }
}

// Export for use
window.Toggle = Toggle;